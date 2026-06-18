import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  NotFoundException,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiProperty,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { CircleRole } from '@prisma/client';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import {
  JobReason,
  MediaFaceStatusType,
  MediaType,
} from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class BackfillFaceDetectionDto {
  @ApiProperty({ description: 'Circle ID to backfill face detection for' })
  @IsString()
  circleId!: string;

  @ApiProperty({
    description: 'Force reprocess even items already marked as processed or no_faces',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Face Detection')
@ApiBearerAuth('JWT-auth')
@Controller()
export class FaceDetectionController {
  private readonly logger = new Logger(FaceDetectionController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // --------------------------------------------------------------------------
  // GET /api/media/:id/faces
  // --------------------------------------------------------------------------

  @Get('media/:id/faces')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List detected faces for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'List of detected faces' })
  async listFaces(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user);

    const faces = await this.prisma.face.findMany({
      where: { mediaItemId },
      select: {
        id: true,
        boundingBox: true,
        confidence: true,
        landmarks: true,
        externalFaceId: true,
        providerKey: true,
        modelVersion: true,
        manuallyAssigned: true,
        personId: true,
        createdAt: true,
        person: {
          select: { name: true },
        },
        // Omit embedding — large vector, not needed for display
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      data: faces.map((f) => ({
        id: f.id,
        boundingBox: f.boundingBox,
        confidence: f.confidence,
        landmarks: f.landmarks,
        externalFaceId: f.externalFaceId,
        providerKey: f.providerKey,
        modelVersion: f.modelVersion,
        manuallyAssigned: f.manuallyAssigned,
        personId: f.personId,
        personName: f.person?.name ?? null,
        createdAt: f.createdAt,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/faces/status
  // --------------------------------------------------------------------------

  @Get('media/:id/faces/status')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get face detection status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Face detection status' })
  async getFaceStatus(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user);

    const status = await this.prisma.mediaFaceStatus.findUnique({
      where: { mediaItemId },
      select: {
        status: true,
        faceCount: true,
        providerKey: true,
        modelVersion: true,
        processedAt: true,
        lastError: true,
        updatedAt: true,
      },
    });

    if (!status) {
      return {
        data: {
          status: MediaFaceStatusType.not_processed,
          faceCount: 0,
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
  // POST /api/media/:id/faces/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/faces/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run face detection for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Face detection job queued' })
  async rerunFaceDetection(
    @Param('id') mediaItemId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // rerun requires collaborator role or higher
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'collaborator' as CircleRole,
    );

    // Always create a new job on rerun — user intentionally requested it
    // Use priority 0 (highest) so user-triggered reruns are processed first
    const job = await this.enrichmentJobService.enqueue({
      type: 'face_detection',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    // Upsert MediaFaceStatus to pending
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: MediaFaceStatusType.pending,
        faceCount: 0,
      },
      update: {
        status: MediaFaceStatusType.pending,
      },
    });

    this.logger.log(
      `Rerun face job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }

  // --------------------------------------------------------------------------
  // POST /api/face/backfill
  // --------------------------------------------------------------------------

  @Post('face/backfill')
  @Auth({ permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Backfill face detection for all unprocessed photos in a circle (Admin)',
  })
  @ApiResponse({ status: 201, description: 'Backfill jobs queued' })
  async backfillFaceDetection(
    @Body() dto: BackfillFaceDetectionDto,
    @CurrentUser() user: RequestUser,
  ) {
    const { circleId, force = false } = dto;

    // Require circle to have faceRecognitionEnabled before accepting a backfill
    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { faceRecognitionEnabled: true },
    });
    if (!circle) {
      throw new NotFoundException(`Circle ${circleId} not found`);
    }
    if (!circle.faceRecognitionEnabled) {
      throw new BadRequestException(
        'Face recognition is not enabled for this circle. Enable it via PUT /api/circles/:id/face-settings before running backfill.',
      );
    }

    // Find media items that need (re-)processing
    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: MediaType.photo,
        deletedAt: null,
        ...(force
          ? {}
          : {
              OR: [
                { faceStatus: null },
                {
                  faceStatus: {
                    status: {
                      notIn: [
                        MediaFaceStatusType.processed,
                        MediaFaceStatusType.no_faces,
                      ],
                    },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    if (mediaItems.length === 0) {
      return { data: { queued: 0 } };
    }

    // Enqueue via EnrichmentJobService (priority 100 = low priority, processed last)
    let queued = 0;
    for (const item of mediaItems) {
      await this.enrichmentJobService.enqueue({
        type: 'face_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      // Upsert MediaFaceStatus rows to pending
      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: MediaFaceStatusType.pending,
          faceCount: 0,
        },
        update: {
          status: MediaFaceStatusType.pending,
        },
      });

      queued++;
    }

    this.logger.log(
      `Backfill: queued ${queued} face detection job(s) for circle ${circleId} by user ${user.id}`,
    );

    return { data: { queued } };
  }

  // --------------------------------------------------------------------------
  // DELETE /api/face/biometrics?circleId=
  // --------------------------------------------------------------------------

  @Delete('face/biometrics')
  @Auth({ permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete ALL biometric data for a circle (GDPR right to erase)',
    description:
      'Permanently deletes all Face rows, Person rows, MediaFaceStatus rows, and EnrichmentJob rows ' +
      'for the specified circle. Also sets faceRecognitionEnabled=false. ' +
      'Requires system Admin OR circle_admin role. THIS ACTION IS IRREVERSIBLE.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, description: 'Circle ID' })
  @ApiResponse({ status: 200, description: 'Biometric data deleted' })
  @ApiResponse({ status: 400, description: 'Missing circleId parameter' })
  @ApiResponse({ status: 403, description: 'Access denied (Admin or circle_admin required)' })
  @ApiResponse({ status: 404, description: 'Circle not found' })
  async deleteAllBiometrics(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    if (!circleId) {
      throw new BadRequestException('circleId query parameter is required');
    }

    // Require circle_admin (super-admin bypasses via isSuperAdmin)
    await this.circleMembershipService.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      'circle_admin' as CircleRole,
    );

    // Execute in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Count before deletion for the response
      const [faceCount, personCount] = await Promise.all([
        tx.face.count({ where: { circleId } }),
        tx.person.count({ where: { circleId } }),
      ]);

      // 1. Delete all Face rows first (before Person to avoid FK violations on face.personId)
      await tx.face.deleteMany({ where: { circleId } });

      // 2. Delete all Person rows (hard delete — faces already removed)
      await tx.person.deleteMany({ where: { circleId } });

      // 3. Delete EnrichmentJob rows for face_detection type in this circle
      await tx.enrichmentJob.deleteMany({
        where: { circleId, type: 'face_detection' },
      });

      // 4. Delete all MediaFaceStatus rows (via mediaItem.circleId join)
      await tx.mediaFaceStatus.deleteMany({
        where: {
          mediaItem: { circleId },
        },
      });

      // 5. Set faceRecognitionEnabled = false
      await tx.circle.update({
        where: { id: circleId },
        data: { faceRecognitionEnabled: false },
      });

      // 6. Audit
      await tx.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: 'face:biometrics_delete',
          targetType: 'circle',
          targetId: circleId,
          meta: { deletedFaces: faceCount, deletedPeople: personCount } as any,
        },
      });

      return { deletedFaces: faceCount, deletedPeople: personCount };
    });

    this.logger.log(
      `Biometrics deleted for circle ${circleId} by user ${user.id}: ` +
        `${result.deletedFaces} face(s), ${result.deletedPeople} person(s)`,
    );

    return { data: result };
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
