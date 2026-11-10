import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { adminTaggingBackfillSchema } from '@marinoscar/memoriahub-contract/tagging';

import { isFeatureEnabled, MemoriahubAuth } from '../core/index.js';
import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../ports/index.js';
import { TAGGING_PERMISSIONS as PERMISSIONS, TAGGING_ROLES as ROLES } from './constants.js';
import { TaggingBackfillService } from './tagging-backfill.service.js';

class AdminBackfillDto extends createZodDto(adminTaggingBackfillSchema) {}

/**
 * `POST /api/admin/tagging/backfill`; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Tagging')
@ApiBearerAuth('JWT-auth')
@Controller('admin/tagging')
export class AdminTaggingController {
  private readonly logger = new Logger(AdminTaggingController.name);

  constructor(
    private readonly tagBackfillService: TaggingBackfillService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill AI tagging across ALL circles (Admin)',
    description:
      'Queues AI tagging for unprocessed (or all, if forced) media across every circle. ' +
      'Photos only by default — pass mediaTypes: ["photo","video"] to include videos, ' +
      'which routes each video to video_auto_tagging.',
  })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Auto-tagging is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminBackfillDto) {
    // Same gate as the kill switch and the `features.autoTagging` flag the settings service answers.
    const enabled = await isFeatureEnabled(this.settings, 'autoTagging');
    if (!enabled) {
      throw new BadRequestException('Auto-tagging is disabled globally');
    }
    const result = await this.tagBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
      ...(dto.mediaTypes ? { mediaTypes: dto.mediaTypes as string[] } : {}),
    });
    return { data: result };
  }
}
