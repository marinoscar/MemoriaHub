import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  FaceJobStatus,
  FaceJobReason,
  MediaFaceStatusType,
  MediaType,
} from '@prisma/client';

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
@Controller()
export class FaceDetectionController {
  private readonly logger = new Logger(FaceDetectionController.name);

  constructor(private readonly prisma: PrismaService) {}

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
        // Omit embedding — large vector, not needed for display
      },
      orderBy: { createdAt: 'asc' },
    });

    return { data: faces };
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
    const mediaItem = await this.assertMediaItemAccess(mediaItemId, user);

    // Always create a new job on rerun — user intentionally requested it
    const job = await this.prisma.faceJob.create({
      data: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: FaceJobStatus.pending,
        reason: FaceJobReason.rerun,
        attempts: 0,
      },
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

    // Create FaceJob rows in bulk
    await this.prisma.faceJob.createMany({
      data: mediaItems.map((item) => ({
        mediaItemId: item.id,
        circleId: item.circleId,
        status: FaceJobStatus.pending,
        reason: FaceJobReason.backfill,
        attempts: 0,
      })),
      skipDuplicates: false,
    });

    // Upsert MediaFaceStatus rows to pending
    for (const item of mediaItems) {
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
    }

    this.logger.log(
      `Backfill: queued ${mediaItems.length} face detection job(s) for circle ${circleId} by user ${user.id}`,
    );

    return { data: { queued: mediaItems.length } };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: RequestUser,
  ): Promise<{ id: string; circleId: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Check circle membership (super-admin bypass via media:read_any permission)
    const hasSuperAdmin = user.permissions.includes(PERMISSIONS.MEDIA_READ_ANY);
    if (!hasSuperAdmin) {
      const member = await this.prisma.circleMember.findUnique({
        where: {
          circleId_userId: {
            circleId: mediaItem.circleId,
            userId: user.id,
          },
        },
        select: { id: true },
      });

      if (!member) {
        throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
      }
    }

    return { id: mediaItem.id, circleId: mediaItem.circleId };
  }
}
