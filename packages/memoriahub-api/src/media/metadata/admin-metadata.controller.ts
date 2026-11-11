import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { MemoriahubAuth } from '../../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS, MEDIA_ROLES as ROLES } from '../constants/permissions.js';
import { MetadataBackfillService } from './metadata-backfill.service.js';
import { adminMetadataBackfillSchema } from '@marinoscar/memoriahub-contract/media';

/**
 * The body of `POST /api/admin/metadata/backfill`.
 *
 * @stability experimental
 */
export class AdminMetadataBackfillDto extends createZodDto(adminMetadataBackfillSchema) {}

/**
 * `POST /api/admin/metadata/backfill`; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Metadata')
@ApiBearerAuth('JWT-auth')
@Controller('admin/metadata')
export class AdminMetadataController {
  private readonly logger = new Logger(AdminMetadataController.name);

  constructor(
    private readonly metadataBackfillService: MetadataBackfillService,
  ) {}

  @Post('backfill')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill metadata extraction across ALL circles (Admin)' })
  @ApiResponse({ status: 201, description: 'Backfill jobs enqueued' })
  async backfillAllCircles(@Body() dto: AdminMetadataBackfillDto) {
    const result = await this.metadataBackfillService.backfillAllCircles({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    return { data: result };
  }
}
