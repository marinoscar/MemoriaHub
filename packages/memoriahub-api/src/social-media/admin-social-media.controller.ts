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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { adminSocialMediaBackfillSchema } from '@marinoscar/memoriahub-contract/social';

import { MemoriahubAuth, isFeatureEnabled } from '../core/index.js';
import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../ports/index.js';
import { SOCIAL_MEDIA_PERMISSIONS as PERMISSIONS, SOCIAL_MEDIA_ROLES as ROLES } from './constants.js';
import { SocialMediaBackfillService } from './social-media-backfill.service.js';
import { SocialMediaOcrService } from './social-media-ocr.service.js';

/**
 * The body of `POST /api/admin/social-media/backfill`.
 *
 * @stability experimental
 */
export class AdminSocialMediaBackfillDto extends createZodDto(
  adminSocialMediaBackfillSchema,
) {}

/**
 * The `AdminSocialMediaController` routes (`POST /api/admin/social-media/backfill`,
 * `GET /api/admin/social-media/status`); mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Social Media Detection')
@ApiBearerAuth('JWT-auth')
@Controller('admin/social-media')
export class AdminSocialMediaController {
  private readonly logger = new Logger(AdminSocialMediaController.name);

  constructor(
    private readonly socialMediaBackfillService: SocialMediaBackfillService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly socialMediaOcr: SocialMediaOcrService,
  ) {}

  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill social-media detection across ALL circles (Admin)',
  })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Social-media detection is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminSocialMediaBackfillDto) {
    const enabled = await isFeatureEnabled(this.settings, 'socialMediaDetection');
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
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get social-media detection OCR availability and config (Admin)',
  })
  @ApiResponse({ status: 200, description: 'OCR availability and configuration' })
  async getStatus() {
    const ocrStatus = await this.socialMediaOcr.getStatus();
    const { value: socialMedia } = await this.settings.readSystem<
      | {
          ocrEnabled?: boolean;
          minConfidence?: number;
          ocrMaxFrames?: number;
          ocrTimeoutSeconds?: number;
        }
      | undefined
    >('socialMedia');

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
