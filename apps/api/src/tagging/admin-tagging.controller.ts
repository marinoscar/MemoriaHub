import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MediaType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { adminTaggingBackfillSchema } from '@marinoscar/memoriahub-contract/tagging';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { FEATURE_KEYS } from '../settings/feature-gates';
import { TaggingBackfillService } from './tagging-backfill.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

class AdminBackfillDto extends createZodDto(adminTaggingBackfillSchema) {}

@ApiTags('Admin: Tagging')
@ApiBearerAuth('JWT-auth')
@Controller('admin/tagging')
export class AdminTaggingController {
  private readonly logger = new Logger(AdminTaggingController.name);

  constructor(
    private readonly tagBackfillService: TaggingBackfillService,
    private readonly systemSettingsService: AppSystemSettingsService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
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
    const enabled = await this.systemSettingsService.isFeatureEnabled(FEATURE_KEYS.AUTO_TAGGING);
    if (!enabled) {
      throw new BadRequestException('Auto-tagging is disabled globally');
    }
    const result = await this.tagBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
      ...(dto.mediaTypes ? { mediaTypes: dto.mediaTypes as MediaType[] } : {}),
    });
    return { data: result };
  }
}
