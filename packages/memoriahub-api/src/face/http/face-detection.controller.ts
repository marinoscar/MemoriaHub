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
  Inject,
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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { MediaThumbnailService } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubScopeRole,
} from '../../ports/index.js';
import type { FaceDb } from '../host/face-db.js';
import { JobReason, MediaFaceStatusType, MediaType } from '../host/face-enums.js';
import { FACE_PERMISSIONS as PERMISSIONS } from '../host/face-permissions.js';
import { FaceJobs } from '../host/face-jobs.js';
import { PeopleService } from '../people.service.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * The body of `POST /media/:id/people`: exactly one of `personId` and `name`.
 *
 * @stability experimental
 */
export class AddPersonToMediaDto {
  @ApiProperty({
    description: 'Existing person ID (UUID); mutually exclusive with name',
    required: false,
  })
  personId?: string;

  @ApiProperty({
    description:
      'Person name; finds or creates a person in the circle; mutually exclusive with personId',
    required: false,
  })
  name?: string;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * The face routes on media items and the biometric erase: `/media/:id/faces`, `/media/:id/people`, `/face/biometrics`. Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Face Detection')
@ApiBearerAuth('JWT-auth')
@Controller()
export class FaceDetectionController {
  private readonly logger = new Logger(FaceDetectionController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: FaceDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembershipService: MemoriahubAccessPort,
    private readonly enrichmentJobService: FaceJobs,
    private readonly peopleService: PeopleService,
    private readonly mediaThumbnailService: MediaThumbnailService,
  ) {}

  // --------------------------------------------------------------------------
  // GET /api/media/:id/faces
  // --------------------------------------------------------------------------

  /** List detected faces for a media item. */
  @Get('media/:id/faces')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List detected faces for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'List of detected faces (includes videoTimestampMs, videoTimestamps, faceThumbnailUrl for video faces)' })
  async listFaces(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user);

    const faces = await this.prisma.face.findMany({
      where: { mediaItemId },
      select: {
        id: true,
        boundingBox: true,
        confidence: true,
        landmarks: true,
        providerKey: true,
        modelVersion: true,
        manuallyAssigned: true,
        personId: true,
        createdAt: true,
        videoTimestampMs: true,
        videoTimestamps: true,
        frameThumbnailKey: true,
        person: {
          select: { name: true },
        },
        // Omit embedding — large vector, not needed for display
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      data: await Promise.all(
        faces.map(async (f) => ({
          id: f.id,
          boundingBox: f.boundingBox,
          confidence: f.confidence,
          landmarks: f.landmarks,
          providerKey: f.providerKey,
          modelVersion: f.modelVersion,
          manuallyAssigned: f.manuallyAssigned,
          personId: f.personId,
          personName: f.person?.name ?? null,
          createdAt: f.createdAt,
          videoTimestampMs: f.videoTimestampMs ?? null,
          videoTimestamps: f.videoTimestamps ?? [],
          faceThumbnailUrl: f.frameThumbnailKey
            ? await this.mediaThumbnailService.signThumb({ thumbnailStorageKey: f.frameThumbnailKey })
            : null,
        })),
      ),
    };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/faces/status
  // --------------------------------------------------------------------------

  /** Get face detection status for a media item. */
  @Get('media/:id/faces/status')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get face detection status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Face detection status' })
  async getFaceStatus(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
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

  /** Re-run face detection for a media item. */
  @Post('media/:id/faces/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run face detection for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Face detection job queued' })
  async rerunFaceDetection(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    // rerun requires collaborator role or higher
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'editor',
    );

    // Always create a new job on rerun — user intentionally requested it
    // Use priority 0 (highest) so user-triggered reruns are processed first
    // Route to the correct handler: video items use video_face_detection;
    // the video handler internally checks face.video.enabled, so we do not
    // gate on that setting here.
    const jobType =
      mediaItem.type === MediaType.video ? 'video_face_detection' : 'face_detection';

    const job = await this.enrichmentJobService.enqueue({
      type: jobType,
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
      `Rerun ${jobType} job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    // A freshly queued job is `pending`; the queue facade reported the row's status the same way.
    return { data: { jobId: job.id, status: 'pending' } };
  }

  // --------------------------------------------------------------------------
  // DELETE /api/face/biometrics?circleId=
  // --------------------------------------------------------------------------

  /** Delete ALL biometric data for a circle (GDPR right to erase). */
  @Delete('face/biometrics')
  @MemoriahubAuth({ permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete ALL biometric data for a circle (GDPR right to erase)',
    description:
      'Permanently deletes all Face rows, Person rows, MediaFaceStatus rows, and EnrichmentJob rows ' +
      'for the specified circle. ' +
      'Requires system Admin OR circle_admin role. THIS ACTION IS IRREVERSIBLE.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, description: 'Circle ID' })
  @ApiResponse({ status: 200, description: 'Biometric data deleted' })
  @ApiResponse({ status: 400, description: 'Missing circleId parameter' })
  @ApiResponse({ status: 403, description: 'Access denied (Admin or circle_admin required)' })
  @ApiResponse({ status: 404, description: 'Circle not found' })
  async deleteAllBiometrics(
    @Query('circleId') circleId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    if (!circleId) {
      throw new BadRequestException('circleId query parameter is required');
    }

    // Require circle_admin (super-admin bypasses via isSuperAdmin)
    await this.circleMembershipService.requireOwnerRole(
      user.id,
      circleId,
      user.permissions,
      'admin',
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
      // (the circle of a media-item job lives in `payload.circleId`; see FaceJobs)
      await tx.job.deleteMany({
        where: {
          type: 'face_detection',
          OR: [
            { subjectType: 'circle', subjectId: circleId },
            { payload: { path: ['circleId'], equals: circleId } },
          ],
        },
      });

      // 4. Delete all MediaFaceStatus rows (via mediaItem.circleId join)
      await tx.mediaFaceStatus.deleteMany({
        where: {
          mediaItem: { circleId },
        },
      });

      // 5. Audit
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
  // POST /api/media/:id/people
  // --------------------------------------------------------------------------

  /** Manually associate a person with a media item (no bounding box required). */
  @Post('media/:id/people')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Manually associate a person with a media item (no bounding box required)',
  })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Association created or returned if already exists' })
  @ApiResponse({ status: 400, description: 'Must provide personId or name (not both)' })
  @ApiResponse({ status: 403, description: 'Collaborator role required' })
  @ApiResponse({ status: 404, description: 'Media item or person not found' })
  async addPersonToMedia(
    @Param('id') mediaItemId: string,
    @Body() dto: AddPersonToMediaDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    if (!dto.personId && !dto.name) {
      throw new BadRequestException('Provide either personId or name');
    }
    if (dto.personId && dto.name) {
      throw new BadRequestException('Provide either personId or name, not both');
    }
    const result = await this.peopleService.addPersonToMedia(
      mediaItemId,
      user.id,
      user.permissions,
      dto,
    );
    return { data: result };
  }

  // --------------------------------------------------------------------------
  // DELETE /api/media/:id/people/:personId
  // --------------------------------------------------------------------------

  /** Remove manual person association from a media item. */
  @Delete('media/:id/people/:personId')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove manual person association from a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiParam({ name: 'personId', description: 'Person ID to disassociate' })
  @ApiResponse({ status: 204, description: 'Manual association removed' })
  @ApiResponse({ status: 403, description: 'Collaborator role required' })
  @ApiResponse({ status: 404, description: 'Media item not found or no manual association exists' })
  async removePersonFromMedia(
    @Param('id') mediaItemId: string,
    @Param('personId') personId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.peopleService.removePersonFromMedia(
      mediaItemId,
      personId,
      user.id,
      user.permissions,
    );
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: MemoriahubRequestUser,
    requiredRole: MemoriahubScopeRole = 'viewer',
  ): Promise<{ id: string; circleId: string; type: MediaType }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true, type: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId, type: mediaItem.type };
  }
}
