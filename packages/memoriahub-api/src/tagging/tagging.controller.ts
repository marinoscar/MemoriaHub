import {
  Controller,
  Inject,
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

import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubScopeRole,
} from '../ports/index.js';
import {
  JOB_REASON,
  MEDIA_TYPE,
  TAG_STATUS,
  TAGGING_JOB_TYPES,
  TAGGING_PERMISSIONS as PERMISSIONS,
} from './constants.js';
import type { TaggingDb } from './data/tagging-db.js';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * `POST /api/media/:id/tags/rerun` and `GET /api/media/:id/tags/status`; mounted by the host in
 * its own module.
 *
 * @stability experimental
 */
@ApiTags('Tagging')
@ApiBearerAuth('JWT-auth')
@Controller()
export class TaggingController {
  private readonly logger = new Logger(TaggingController.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: TaggingDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  // --------------------------------------------------------------------------
  // POST /api/media/:id/tags/rerun
  // --------------------------------------------------------------------------

  @Post('media/:id/tags/rerun')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run auto-tagging for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 201, description: 'Auto-tagging job queued' })
  async rerunTagging(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    const mediaItem = await this.assertMediaItemAccess(
      mediaItemId,
      user,
      'editor',
    );

    // Route by media type (epic #452, issue #458). This endpoint previously
    // had NO type guard at all, so a video id enqueued an `auto_tagging` job
    // the handler then failed.
    const jobType =
      mediaItem.type === MEDIA_TYPE.video ? TAGGING_JOB_TYPES.videoAutoTagging : TAGGING_JOB_TYPES.autoTagging;

    const job = await this.jobs.enqueue({
      type: jobType,
      reason: JOB_REASON.rerun,
      subjectType: 'media_item',
      subjectId: mediaItemId,
      payload: { circleId: mediaItem.circleId },
      priority: 0,
    });

    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: TAG_STATUS.pending,
        tagCount: 0,
      },
      update: {
        status: TAG_STATUS.pending,
      },
    });

    this.logger.log(
      `Rerun ${jobType} job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${user.id}`,
    );

    // A freshly queued job is `pending`; the queue facade reported the row's status the same way.
    return { data: { jobId: job.id, status: 'pending' } };
  }

  // --------------------------------------------------------------------------
  // GET /api/media/:id/tags/status
  // --------------------------------------------------------------------------

  @Get('media/:id/tags/status')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get auto-tagging status for a media item' })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({ status: 200, description: 'Auto-tagging status' })
  async getTagStatus(
    @Param('id') mediaItemId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    await this.assertMediaItemAccess(mediaItemId, user, 'viewer');

    const status = await this.prisma.mediaTagStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        data: {
          status: TAG_STATUS.not_processed,
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
  // Private helpers
  // --------------------------------------------------------------------------

  private async assertMediaItemAccess(
    mediaItemId: string,
    user: MemoriahubRequestUser,
    requiredRole: MemoriahubScopeRole = 'viewer',
  ): Promise<{ id: string; circleId: string; type: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, type: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.access.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      requiredRole,
    );

    return { id: mediaItem.id, circleId: mediaItem.circleId, type: mediaItem.type };
  }
}
