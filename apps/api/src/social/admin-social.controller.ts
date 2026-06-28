import {
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
import { SocialBackfillService } from './social-backfill.service';
import { SocialDetectionService } from './social-detection.service';
import { PLATFORM_DETECTORS, SOCIAL_MAIN_TAG } from './social-detectors';

const flexibleDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });
const adminSocialBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
});
class AdminSocialBackfillDto extends createZodDto(adminSocialBackfillSchema) {}

@ApiTags('Admin — Social Media Detection')
@ApiBearerAuth('JWT-auth')
@Controller('admin/social')
export class AdminSocialController {
  private readonly logger = new Logger(AdminSocialController.name);

  constructor(
    private readonly socialBackfillService: SocialBackfillService,
    private readonly socialDetectionService: SocialDetectionService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill social media detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  async backfillAllCircles(@Body() dto: AdminSocialBackfillDto) {
    const result = await this.socialBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }

  @Get('detectors')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'List supported social media platform detectors (Admin)' })
  @ApiResponse({ status: 200, description: 'List of platform detectors and system tag names' })
  async listDetectors() {
    const platforms = PLATFORM_DETECTORS.map((d) => ({
      key: d.key,
      tagName: d.tagName,
    }));

    return {
      data: {
        mainTag: SOCIAL_MAIN_TAG,
        platforms,
        allSystemTagNames: this.socialDetectionService.getSupportedTagNames(),
      },
    };
  }
}
