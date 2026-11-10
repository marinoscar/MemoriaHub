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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { MemoriahubAuth } from '../../core/index.js';
import { FaceBackfillService } from '../face-backfill.service.js';
import { FACE_PERMISSIONS as PERMISSIONS, FACE_ROLES as ROLES } from '../host/face-permissions.js';
import { FaceSystemSettings } from '../host/face-system-settings.js';
import { adminFaceBackfillSchema } from '@marinoscar/memoriahub-contract/face';

/**
 * The body of the admin face backfill routes.
 *
 * @stability experimental
 */
export class AdminFaceBackfillDto extends createZodDto(adminFaceBackfillSchema) {}

/**
 * The `/admin/face` backfill routes (Admin): face detection across every library and the auto-archive sweep. Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Face Recognition')
@ApiBearerAuth('JWT-auth')
@Controller('admin/face')
export class AdminFaceBackfillController {
  private readonly logger = new Logger(AdminFaceBackfillController.name);

  constructor(
    private readonly faceBackfillService: FaceBackfillService,
    private readonly systemSettingsService: FaceSystemSettings,
  ) {}

  /** Backfill face detection across ALL circles (Admin). */
  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill face detection across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Face recognition is disabled globally' })
  async backfillAllCircles(@Body() dto: AdminFaceBackfillDto) {
    const enabled = await this.systemSettingsService.isFeatureEnabled('faceRecognition');
    if (!enabled) {
      throw new BadRequestException('Face recognition is disabled globally');
    }
    const result = await this.faceBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }

  /** Backfill face auto-archive across ALL circles (Admin). */
  @Post('auto-archive/backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.FACE_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Backfill face auto-archive across ALL circles (Admin)',
    description:
      'Enqueues one server-only face_auto_archive_sweep job per circle that has archived unassigned faces, hiding live unassigned faces matching the archived reference set.',
  })
  @ApiResponse({ status: 201, description: 'Auto-archive sweep jobs enqueued' })
  @ApiResponse({ status: 400, description: 'Face auto-archive is disabled globally' })
  async autoArchiveBackfillAllCircles() {
    const enabled = await this.systemSettingsService.isFeatureEnabled('faceAutoArchive');
    if (!enabled) {
      throw new BadRequestException('Face auto-archive is disabled globally');
    }
    const result = await this.faceBackfillService.autoArchiveBackfillAllCircles();
    return { data: result };
  }
}
