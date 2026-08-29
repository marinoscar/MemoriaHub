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
  /**
   * Which media types to back-fill. Videos are OPT-IN (epic #452, issue #458):
   * an admin used to running photo backfills would otherwise, on their first
   * run after upgrading, dispatch an AI call for EVERY video in the library —
   * a large, unexpected bill from a command whose behavior they thought they
   * understood. Deliberately no `.default()`: an absent value is resolved in
   * the service, so the default lives in exactly one place.
   */
  mediaTypes: z.array(z.enum(['photo', 'video'])).nonempty().optional(),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false) —
  // see issue #289 (app.module.ts) and admin-metadata.controller.ts.
}).prefault({});
class AdminBackfillDto extends createZodDto(adminBackfillSchema) {}

@ApiTags('Admin: Tagging')
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
