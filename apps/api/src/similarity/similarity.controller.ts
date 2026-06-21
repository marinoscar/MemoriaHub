import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { SimilarityService } from './similarity.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { SimilarityQueryDto } from './dto/similarity-query.dto';
import { ResolveSimilarityDto } from './dto/resolve-similarity.dto';
import { SimilarityBackfillDto } from './dto/similarity-backfill.dto';
import { UpdateDedupSettingsDto } from './dto/update-dedup-settings.dto';

@ApiTags('Similarity')
@ApiBearerAuth()
@Controller()
export class SimilarityController {
  constructor(private readonly similarityService: SimilarityService) {}

  /**
   * GET /api/media/similar
   * List similarity groups for a circle, filtered by status.
   */
  @Get('media/similar')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List similarity groups (near-duplicate photos) for a circle' })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiQuery({ name: 'status', type: String, required: false, enum: ['pending', 'resolved', 'dismissed'] })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Similarity groups listed' })
  async listSimilarityGroups(
    @Query() query: SimilarityQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.listSimilarityGroups(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/similar/backfill
   * Bulk-enqueue similarity_detection jobs for a circle.
   * MUST come before similar/:id to avoid routing conflict.
   */
  @Post('media/similar/backfill')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Backfill visual deduplication for a circle' })
  @ApiResponse({ status: 201, description: 'Backfill enqueued' })
  @ApiResponse({ status: 400, description: 'Circle does not have visual deduplication enabled' })
  async backfillSimilarityDetection(
    @Body() dto: SimilarityBackfillDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.backfillSimilarityDetection(dto, user.id, user.permissions);
  }

  /**
   * GET /api/media/similar/:id
   * Get full detail for a single similarity group.
   */
  @Get('media/similar/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get similarity group detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Similarity group returned' })
  @ApiResponse({ status: 404, description: 'Similarity group not found' })
  async getSimilarityGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.getSimilarityGroup(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/similar/:id/resolve
   * Resolve a similarity group, soft-deleting all non-kept members.
   */
  @Post('media/similar/:id/resolve')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a similarity group (keep selected, delete rest)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Similarity group resolved' })
  @ApiResponse({ status: 400, description: 'Invalid keepIds or group not pending' })
  @ApiResponse({ status: 404, description: 'Similarity group not found' })
  async resolveSimilarityGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSimilarityDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.resolveSimilarityGroup(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/similar/:id/dismiss
   * Dismiss a similarity group (not actually duplicates; ungroups all members).
   */
  @Post('media/similar/:id/dismiss')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a similarity group (not duplicates)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Similarity group dismissed' })
  @ApiResponse({ status: 400, description: 'Group is not in pending status' })
  @ApiResponse({ status: 404, description: 'Similarity group not found' })
  async dismissSimilarityGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.dismissSimilarityGroup(id, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // Per-circle dedup settings (mirrors burst-settings endpoints in CirclesController)
  // ---------------------------------------------------------------------------

  /**
   * GET /api/circles/:id/dedup-settings
   * Returns per-circle visual deduplication opt-in flag.
   */
  @Get('circles/:id/dedup-settings')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @ApiOperation({ summary: 'Get visual deduplication settings for a circle' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Dedup settings returned' })
  async getDedupSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.getDedupSettings(id, user);
  }

  /**
   * PUT /api/circles/:id/dedup-settings
   * Toggle per-circle visual deduplication opt-in. Requires circle_admin.
   */
  @Put('circles/:id/dedup-settings')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update visual deduplication opt-in for a circle (circle_admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Dedup settings updated' })
  async updateDedupSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDedupSettingsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.similarityService.updateDedupSettings(id, dto.enabled, user);
  }
}
