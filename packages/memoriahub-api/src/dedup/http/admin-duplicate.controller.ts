import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  adminDuplicateBackfillSchema,
  adminDuplicateConfidenceBackfillSchema,
} from '@marinoscar/memoriahub-contract/dedup';

import { MemoriahubAuth, isFeatureEnabled } from '../../core/index.js';
import { enqueueEnrichmentJob } from '../../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { DedupDb } from '../data/dedup-db.js';
import { DuplicateBackfillService } from '../duplicate-backfill.service.js';
import { VISUAL_EMBEDDING_MODEL_TAG, VisualEmbeddingService } from '../visual-embedding.service.js';
import { DEDUP_PERMISSIONS as PERMISSIONS, DEDUP_ROLES as ROLES } from './dedup-permissions.js';

// Both schemas below accept a bodyless POST — see issue #289 (app.module.ts).
// This one uses .prefault({}) rather than .default({}) so the empty body is fed
// THROUGH the schema and still yields force: false; see the fuller note in
// admin-metadata.controller.ts.
class AdminDuplicateBackfillDto extends createZodDto(adminDuplicateBackfillSchema) {}

class AdminDuplicateConfidenceBackfillDto extends createZodDto(
  adminDuplicateConfidenceBackfillSchema,
) {}

/**
 * The `AdminDuplicateController` routes (`/api/admin/duplicates/*`); mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Duplicates')
@ApiBearerAuth('JWT-auth')
@Controller('admin/duplicates')
export class AdminDuplicateController {
  private readonly logger = new Logger(AdminDuplicateController.name);

  constructor(
    private readonly duplicateBackfillService: DuplicateBackfillService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly visualEmbeddingService: VisualEmbeddingService,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: DedupDb,
  ) {}

  /** Backfills duplicate detection across every circle (Admin). */
  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill duplicate detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Duplicate detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminDuplicateBackfillDto) {
    const enabled = await isFeatureEnabled(this.settings, 'duplicateDetection');
    if (!enabled) {
      throw new BadRequestException('Duplicate detection is disabled globally');
    }
    const result = await this.duplicateBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }

  /**
   * POST /api/admin/duplicates/confidence/backfill
   *
   * Enqueue the one-pass `duplicate_confidence_backfill` global job (issue
   * #190). Since duplicate-group confidence became a persisted column,
   * recomputeGroupMeta keeps it fresh on every membership change and the read
   * paths self-heal one group at a time — but a pending group that is neither
   * mutated nor viewed would keep a NULL confidence forever, and NULL is
   * excluded from threshold runs in both directions. This closes that
   * historical gap.
   *
   * Deliberately NOT feature-gated on `features.duplicateDetection`: the
   * backfill repairs data that already exists, which an admin may well want to
   * do while the detection feature itself is off.
   */
  @Post('confidence/backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill persisted confidence on pending duplicate groups (Admin)',
  })
  @ApiResponse({ status: 201, description: 'Confidence backfill job enqueued' })
  async backfillConfidence(@Body() dto: AdminDuplicateConfidenceBackfillDto) {
    const { id: jobId } = await enqueueEnrichmentJob(this.jobs, {
      type: 'duplicate_confidence_backfill',
      mediaItemId: null,
      circleId: null,
      reason: 'backfill',
      priority: 100,
      ...(dto.limit ? { payload: { limit: dto.limit } } : {}),
    });
    const jobRow = await this.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    const job = { id: jobId, status: (jobRow?.status as string | undefined) ?? 'pending' };
    this.logger.log(`Enqueued duplicate_confidence_backfill job ${job.id}`);
    return { data: { jobId: job.id, status: job.status } };
  }

  /** The visual-embedding model status (Admin). */
  @Get('status')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get visual-embedding model availability status (Admin)' })
  @ApiResponse({ status: 200, description: 'Model status returned' })
  async getStatus() {
    const available = this.visualEmbeddingService.isAvailable();
    return {
      data: {
        modelAvailable: available,
        modelPath: this.visualEmbeddingService.getModelPath(),
        degraded: !available,
        model: VISUAL_EMBEDDING_MODEL_TAG,
      },
    };
  }
}
