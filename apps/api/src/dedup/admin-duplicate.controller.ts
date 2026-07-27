import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JobReason } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { DuplicateBackfillService } from './duplicate-backfill.service';
import { VisualEmbeddingService, VISUAL_EMBEDDING_MODEL_TAG } from './visual-embedding.service';

const adminDuplicateBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
});
class AdminDuplicateBackfillDto extends createZodDto(adminDuplicateBackfillSchema) {}

const adminDuplicateConfidenceBackfillSchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
});
class AdminDuplicateConfidenceBackfillDto extends createZodDto(
  adminDuplicateConfidenceBackfillSchema,
) {}

@ApiTags('Admin — Duplicates')
@ApiBearerAuth('JWT-auth')
@Controller('admin/duplicates')
export class AdminDuplicateController {
  private readonly logger = new Logger(AdminDuplicateController.name);

  constructor(
    private readonly duplicateBackfillService: DuplicateBackfillService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly visualEmbeddingService: VisualEmbeddingService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill duplicate detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Duplicate detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminDuplicateBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(FEATURE_KEYS.DUPLICATE_DETECTION);
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
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill persisted confidence on pending duplicate groups (Admin)',
  })
  @ApiResponse({ status: 201, description: 'Confidence backfill job enqueued' })
  async backfillConfidence(@Body() dto: AdminDuplicateConfidenceBackfillDto) {
    const job = await this.enrichmentJobService.enqueue({
      type: 'duplicate_confidence_backfill',
      mediaItemId: null,
      circleId: null,
      reason: JobReason.backfill,
      priority: 100,
      ...(dto.limit ? { payload: { limit: dto.limit } } : {}),
    });
    this.logger.log(`Enqueued duplicate_confidence_backfill job ${job.id}`);
    return { data: { jobId: job.id, status: job.status } };
  }

  @Get('status')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
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
