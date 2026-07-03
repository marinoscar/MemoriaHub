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
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { DuplicateBackfillService } from './duplicate-backfill.service';
import { VisualEmbeddingService, VISUAL_EMBEDDING_MODEL_TAG } from './visual-embedding.service';

const adminDuplicateBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
});
class AdminDuplicateBackfillDto extends createZodDto(adminDuplicateBackfillSchema) {}

@ApiTags('Admin — Duplicates')
@ApiBearerAuth('JWT-auth')
@Controller('admin/duplicates')
export class AdminDuplicateController {
  private readonly logger = new Logger(AdminDuplicateController.name);

  constructor(
    private readonly duplicateBackfillService: DuplicateBackfillService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly visualEmbeddingService: VisualEmbeddingService,
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
