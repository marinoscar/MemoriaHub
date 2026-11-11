import { Controller, Inject, Post, Param, NotFoundException, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { MEMORIAHUB_ACCESS, MEMORIAHUB_PRISMA, type MemoriahubAccessPort } from '../../ports/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../constants/permissions.js';
import type { MediaDb } from '../data/media-db.js';
import { MEDIA_OBJECT_REPROCESSOR, type MediaObjectReprocessor } from '../hooks/media-host-hooks.js';

/**
 * POST /api/media/:id/thumbnail/rerun
 *
 * User-facing "Retry thumbnail" action, mirroring the existing
 * POST /api/media/:id/metadata/rerun pattern (MetadataController). Runs
 * synchronously, one object inside the request, through
 * the host's object reprocessor (`MEDIA_OBJECT_REPROCESSOR`, the platform's
 * run-processors-now API, RETRO-D1b #567 open decision 1), since thumbnail
 * generation is a few seconds at most and the response reports the outcome.
 * Bypasses the stuck-threshold/retry-cap that gates the automatic recovery
 * cron — an explicit user request should always get a fresh attempt.
 *
 * Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller()
export class MediaThumbnailRerunController {
  private readonly logger = new Logger(MediaThumbnailRerunController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembershipService: MemoriahubAccessPort,
    @Inject(MEDIA_OBJECT_REPROCESSOR) private readonly recoveryService: MediaObjectReprocessor,
  ) {}

  /** Re-runs thumbnail generation for one photo or video, synchronously, and reports the resulting storage status. */
  @Post('media/:id/thumbnail/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run thumbnail generation for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: '{ status: "ready" | "failed" }' })
  async rerunThumbnail(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ): Promise<{ data: { status: string } }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true, storageObject: true },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'editor',
    );

    await this.recoveryService.reprocessNow(mediaItem.storageObject);

    this.logger.log(`Thumbnail rerun triggered for MediaItem ${mediaItemId} by user ${user.id}`);

    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: mediaItem.storageObject.id },
      select: { status: true },
    });

    return { data: { status: refreshed?.status ?? 'unknown' } };
  }
}
