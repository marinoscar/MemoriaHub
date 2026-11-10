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
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { MetadataBackfillService } from './metadata-backfill.service';
import { adminMetadataBackfillSchema } from '@marinoscar/memoriahub-contract/media';

class AdminMetadataBackfillDto extends createZodDto(adminMetadataBackfillSchema) {}

@ApiTags('Admin: Metadata')
@ApiBearerAuth('JWT-auth')
@Controller('admin/metadata')
export class AdminMetadataController {
  private readonly logger = new Logger(AdminMetadataController.name);

  constructor(
    private readonly metadataBackfillService: MetadataBackfillService,
  ) {}

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
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
