import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';
import { FaceBackfillService } from './face-backfill.service';

class AdminFaceBackfillDto {
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

@ApiTags('Admin — Face Recognition')
@ApiBearerAuth('JWT-auth')
@Controller('admin/face')
export class AdminFaceBackfillController {
  private readonly logger = new Logger(AdminFaceBackfillController.name);

  constructor(
    private readonly faceBackfillService: FaceBackfillService,
    private readonly systemSettingsService: SystemSettingsService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill face detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Face recognition is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminFaceBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled(FEATURE_KEYS.FACE_RECOGNITION);
    if (!enabled) {
      throw new BadRequestException('Face recognition is disabled globally');
    }
    const result = await this.faceBackfillService.backfillAllCircles({
      force: dto.force,
    });
    return { data: result };
  }
}
