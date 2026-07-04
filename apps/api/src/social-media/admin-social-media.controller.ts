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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SocialMediaBackfillService } from './social-media-backfill.service';
import { SocialMediaOcrService } from './social-media-ocr.service';

const flexibleDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });
const adminSocialMediaBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
});
class AdminSocialMediaBackfillDto extends createZodDto(
  adminSocialMediaBackfillSchema,
) {}

@ApiTags('Admin — Social Media Detection')
@ApiBearerAuth('JWT-auth')
@Controller('admin/social-media')
export class AdminSocialMediaController {
  private readonly logger = new Logger(AdminSocialMediaController.name);

  constructor(
    private readonly socialMediaBackfillService: SocialMediaBackfillService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly socialMediaOcr: SocialMediaOcrService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill social-media detection across ALL circles (Admin)',
  })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Social-media detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminSocialMediaBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(
      FEATURE_KEYS.SOCIAL_MEDIA_DETECTION,
    );
    if (!enabled) {
      throw new BadRequestException('Social-media detection is disabled globally');
    }
    const result = await this.socialMediaBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }

  @Get('status')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get social-media detection OCR availability and config (Admin)',
  })
  @ApiResponse({ status: 200, description: 'OCR availability and configuration' })
  async getStatus() {
    const ocrStatus = await this.socialMediaOcr.getStatus();
    const settings = await this.systemSettingsService.getSettings();
    const socialMedia = settings.socialMedia;

    return {
      data: {
        ocrEnabled: socialMedia?.ocrEnabled ?? false,
        ocrAvailable: ocrStatus.ocrAvailable,
        degraded: ocrStatus.degraded,
        modelPath: ocrStatus.modelPath,
        languages: ocrStatus.languages,
        minConfidence: socialMedia?.minConfidence ?? null,
        ocrMaxFrames: socialMedia?.ocrMaxFrames ?? null,
        ocrTimeoutSeconds: socialMedia?.ocrTimeoutSeconds ?? null,
      },
    };
  }
}
