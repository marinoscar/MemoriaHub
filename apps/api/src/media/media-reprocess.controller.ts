import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MediaReprocessService } from './media-reprocess.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

const reprocessBodySchema = z.object({
  circleId: z.string().uuid().optional(),
  all: z.boolean().optional(),
});

export class ReprocessBodyDto extends createZodDto(reprocessBodySchema) {}

@ApiTags('Admin - Media')
@Controller('admin/media')
export class MediaReprocessController {
  constructor(private readonly reprocessService: MediaReprocessService) {}

  @Post('reprocess')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.STORAGE_DELETE_ANY] })
  @ApiOperation({
    summary: 'Reprocess existing media thumbnails and dimensions (Admin)',
    description:
      'Re-runs ImageDimensionsProcessor and ThumbnailProcessor for all ready image StorageObjects ' +
      'linked to MediaItems in the given circle (circleId) or all circles (all:true). ' +
      'Old thumbnail blobs and StorageObject rows are deleted to prevent storage leaks.',
  })
  @ApiResponse({ status: 201, description: '{ reprocessed: number, failed: number }' })
  async reprocess(@Body() body: ReprocessBodyDto): Promise<{ reprocessed: number; failed: number }> {
    const circleId = body.circleId;
    return this.reprocessService.reprocessCircle(circleId);
  }
}
