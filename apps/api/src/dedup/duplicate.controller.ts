import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DuplicateService } from './duplicate.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { DuplicateQueryDto } from './dto/duplicate-query.dto';
import { ResolveDuplicateDto } from './dto/resolve-duplicate.dto';

@ApiTags('Duplicates')
@ApiBearerAuth()
@Controller('media')
export class DuplicateController {
  constructor(private readonly duplicateService: DuplicateService) {}

  /**
   * GET /api/media/duplicates
   * List duplicate groups for a circle, filtered by status/kind.
   */
  @Get('duplicates')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List near-duplicate groups for a circle' })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiQuery({ name: 'status', type: String, required: false, enum: ['pending', 'resolved', 'dismissed'] })
  @ApiQuery({ name: 'kind', type: String, required: false, enum: ['exact_variant', 'edited', 'similar'] })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Duplicate groups listed' })
  async listDuplicateGroups(
    @Query() query: DuplicateQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.listDuplicateGroups(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/duplicates/:id
   * Get full detail for a single duplicate group.
   */
  @Get('duplicates/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get near-duplicate group detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Duplicate group returned' })
  @ApiResponse({ status: 404, description: 'Duplicate group not found' })
  async getDuplicateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.getDuplicateGroup(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/duplicates/:id/resolve
   * Resolve a duplicate group: keep selected members, archive or trash the rest.
   */
  @Post('duplicates/:id/resolve')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a duplicate group (keep selected, archive/trash rest)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Duplicate group resolved' })
  @ApiResponse({ status: 400, description: 'Invalid keepIds, missing media:delete for trash action, or group not pending' })
  @ApiResponse({ status: 404, description: 'Duplicate group not found' })
  async resolveDuplicateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDuplicateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.resolveDuplicateGroup(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/duplicates/:id/dismiss
   * Dismiss a duplicate group (not actual duplicates; ungroups all members).
   */
  @Post('duplicates/:id/dismiss')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a duplicate group (not duplicates)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Duplicate group dismissed' })
  @ApiResponse({ status: 400, description: 'Group is not in pending status' })
  @ApiResponse({ status: 404, description: 'Duplicate group not found' })
  async dismissDuplicateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.dismissDuplicateGroup(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/:id/duplicates/rerun
   * Re-enqueue duplicate detection for a single media item.
   */
  @Post(':id/duplicates/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run duplicate detection for a media item' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Duplicate detection job queued' })
  async rerunDuplicateDetection(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.rerunDuplicateDetection(id, user.id);
  }
}
