import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CircleRole, JobReason, MediaMetadataStatusType } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Metadata')
@ApiBearerAuth('JWT-auth')
@Controller()
export class MetadataController {
  private readonly logger = new Logger(MetadataController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // --------------------------------------------------------------------------
  // POST /api/media/:id/metadata/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/metadata/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run metadata extraction for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Metadata extraction job queued' })
  async rerunMetadata(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'collaborator' as CircleRole,
    );

    const job = await this.enrichmentJobService.enqueue({
      type: 'metadata_extraction',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaMetadataStatusType.pending,
      },
      update: {
        status: MediaMetadataStatusType.pending,
      },
    });

    this.logger.log(
      `Rerun metadata extraction job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/metadata/status
  // --------------------------------------------------------------------------

  @Get('media/:id/metadata/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get metadata extraction status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Metadata extraction status' })
  async getMetadataStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer' as CircleRole);

    const status = await this.prisma.mediaMetadataStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        data: {
          status: MediaMetadataStatusType.not_processed,
          processedAt: null,
          lastError: null,
        },
      };
    }

    return { data: { status: status.status, processedAt: status.processedAt, lastError: status.lastError } };
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
