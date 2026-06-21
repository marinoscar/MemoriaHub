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
import { z } from 'zod';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { MetadataBackfillService } from './metadata-backfill.service';

const flexibleDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });
const adminMetadataBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
});
class AdminMetadataBackfillDto extends createZodDto(adminMetadataBackfillSchema) {}

@ApiTags('Admin — Metadata')
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
