import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CircleRole, JobReason, MediaTagStatusType, MediaType } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { whereDateRange } from '../search/media-where.builder';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const backfillTaggingSchema = z.object({
  circleId: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  force: z.boolean().optional().default(false),
});

class BackfillTaggingDto extends createZodDto(backfillTaggingSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Tagging')
@ApiBearerAuth('JWT-auth')
@Controller()
export class TaggingController {
  private readonly logger = new Logger(TaggingController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // --------------------------------------------------------------------------
  // POST /api/media/:id/tags/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/tags/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run auto-tagging for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Auto-tagging job queued' })
  async rerunTagging(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'collaborator' as CircleRole,
    );

    const job = await this.enrichmentJobService.enqueue({
      type: 'auto_tagging',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaTagStatusType.pending,
        tagCount: 0,
      },
      update: {
        status: MediaTagStatusType.pending,
      },
    });

    this.logger.log(
      `Rerun auto-tagging job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/tags/status
  // --------------------------------------------------------------------------

  @Get('media/:id/tags/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get auto-tagging status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Auto-tagging status' })
  async getTagStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer' as CircleRole);

    const status = await this.prisma.mediaTagStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        data: {
          status: MediaTagStatusType.not_processed,
          tagCount: 0,
          providerKey: null,
          modelVersion: null,
          processedAt: null,
          lastError: null,
        },
      };
    }

    return { data: status };
  }

  // --------------------------------------------------------------------------
  // POST /api/tagging/backfill
  // --------------------------------------------------------------------------

  @Post('tagging/backfill')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Backfill auto-tagging for unprocessed photos in a circle',
  })
  @ApiResponse({ status: 201, description: 'Backfill jobs queued' })
  async backfillTagging(
    @Body() dto: BackfillTaggingDto,
    @CurrentUser() user: RequestUser,
  ) {
    const { circleId, force = false } = dto;

    await this.circleMembershipService.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      'collaborator' as CircleRole,
    );

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { autoTaggingEnabled: true },
    });

    if (!circle || !circle.autoTaggingEnabled) {
      throw new BadRequestException(
        'Auto-tagging is not enabled for this circle',
      );
    }

    const from = dto.from ? new Date(dto.from) : undefined;
    const to = dto.to ? new Date(dto.to) : undefined;
    const dateWhere = whereDateRange(from, to);

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: MediaType.photo,
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { tagStatus: null },
                {
                  tagStatus: {
                    status: { notIn: [MediaTagStatusType.processed] },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await this.enrichmentJobService.enqueue({
        type: 'auto_tagging',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      await this.prisma.mediaTagStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: MediaTagStatusType.pending,
          tagCount: 0,
        },
        update: {
          status: MediaTagStatusType.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} auto-tagging job(s) for circle ${circleId} by user ${user.id}`,
    );

    return { data: { enqueued } };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: RequestUser,
    requiredRole: CircleRole = 'viewer' as CircleRole,
  ): Promise<{ id: string; circleId: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
