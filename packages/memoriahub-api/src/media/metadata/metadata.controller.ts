import { Controller, Post, Get, Param, NotFoundException, Logger, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubScopeRole,
} from '../../ports/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../constants/permissions.js';
import type { MediaDb } from '../data/media-db.js';
import { enqueueEnrichmentJob } from '../jobs/enrichment-jobs.js';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * `POST /api/media/:id/metadata/rerun` and `GET /api/media/:id/metadata/status`; mounted by the host in
 * its own module.
 *
 * @stability experimental
 */
@ApiTags('Metadata')
@ApiBearerAuth('JWT-auth')
@Controller()
export class MetadataController {
  private readonly logger = new Logger(MetadataController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembershipService: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  // --------------------------------------------------------------------------
  // POST /api/media/:id/metadata/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/metadata/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run metadata extraction for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Metadata extraction job queued' })
  async rerunMetadata(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'editor',
    );

    const job = await enqueueEnrichmentJob(this.jobs, {
      type: 'metadata_extraction',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: 'rerun',
      priority: 0,
      // mimeType rides in the job payload so a distributed worker node can
      // dispatch to the image vs. video compute path without a second lookup —
      // the node only has the presigned download URL, not the DB row.
      payload: { mimeType: mediaItem.mimeType },
    });

    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: 'pending',
      },
      update: {
        status: 'pending',
      },
    });

    this.logger.log(
      `Rerun metadata extraction job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    // A freshly queued job is `pending`; the queue facade reported the row's status the same way.
    return { data: { jobId: job.id, status: 'pending' } };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/metadata/status
  // --------------------------------------------------------------------------

  @Get('media/:id/metadata/status')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get metadata extraction status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Metadata extraction status' })
  async getMetadataStatus(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer');

    const status = await this.prisma.mediaMetadataStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        data: {
          status: 'not_processed',
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
    user: MemoriahubRequestUser,
    requiredRole: MemoriahubScopeRole = 'viewer',
  ): Promise<{ id: string; circleId: string; mimeType: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        storageObject: { select: { mimeType: true } },
      },
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

    return {
      id: mediaItem.id,
      circleId: mediaItem.circleId,
      mimeType: mediaItem.storageObject?.mimeType ?? 'application/octet-stream',
    };
  }
}
