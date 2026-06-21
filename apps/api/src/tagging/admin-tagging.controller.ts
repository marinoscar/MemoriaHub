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
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { TaggingBackfillService } from './tagging-backfill.service';

const flexibleDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });
const adminBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
});
class AdminBackfillDto extends createZodDto(adminBackfillSchema) {}

@ApiTags('Admin — Tagging')
@ApiBearerAuth('JWT-auth')
@Controller('admin/tagging')
export class AdminTaggingController {
  private readonly logger = new Logger(AdminTaggingController.name);

  constructor(
    private readonly tagBackfillService: TaggingBackfillService,
    private readonly systemSettingsService: SystemSettingsService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill auto-tagging across ALL circles (Admin)' })
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
    });
    return { data: result };
  }
}
