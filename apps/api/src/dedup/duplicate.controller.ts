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
import { BulkResolveDuplicateDto } from './dto/bulk-resolve-duplicate.dto';
import { BulkResolveDuplicateThresholdDto } from './dto/bulk-resolve-duplicate-threshold.dto';
import { BulkDismissDuplicateThresholdDto } from './dto/bulk-dismiss-duplicate-threshold.dto';

@ApiTags('Duplicates')
@ApiBearerAuth('JWT-auth')
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
  @ApiQuery({ name: 'sortBy', type: String, required: false, enum: ['capturedAt', 'confidence', 'mediaCount'] })
  @ApiQuery({ name: 'sortOrder', type: String, required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Duplicate groups listed' })
  async listDuplicateGroups(
    @Query() query: DuplicateQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.listDuplicateGroups(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/duplicates/bulk/resolve
   * Bulk-resolve multiple duplicate groups, auto-keeping each group's
   * suggested-best item and applying the chosen action to the rest.
   *
   * IMPORTANT: declared BEFORE `duplicates/:id` routes so the static `bulk`
   * segment is not captured by the `:id` param.
   */
  @Post('duplicates/bulk/resolve')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-resolve duplicate groups (auto-keep suggested best, archive/trash rest)',
    description:
      'Resolves 1–100 duplicate groups at once. For each pending group, keeps its ' +
      'suggested-best item and applies the chosen `action` to the remaining live ' +
      'members: `archive` sets archivedAt, `trash` soft-deletes (sets deletedAt). ' +
      'Groups that are not pending or have no valid suggested-best item are skipped. ' +
      'Requires media:write; `action: "trash"` additionally requires media:delete.',
  })
  @ApiResponse({ status: 200, description: 'Bulk resolve completed' })
  @ApiResponse({
    status: 400,
    description: 'Invalid body, missing media:delete for trash, or IDs not found / cross-circle',
  })
  @ApiResponse({ status: 404, description: 'Circle not found or access denied' })
  async bulkResolveDuplicateGroups(
    @Body() dto: BulkResolveDuplicateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.bulkResolveDuplicateGroups(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/duplicates/bulk/resolve-by-threshold
   * Bulk-resolve every pending duplicate group whose read-time confidence is
   * at/above the given threshold (0–100), auto-keeping the suggested-best item.
   *
   * IMPORTANT: declared BEFORE `duplicates/:id` routes so the static `bulk`
   * segment is not captured by the `:id` param.
   */
  @Post('duplicates/bulk/resolve-by-threshold')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a run resolving duplicate groups at/above a confidence threshold',
    description:
      'Starts an ASYNC review run (issue #190) that resolves every pending ' +
      'duplicate group in the circle whose `confidence` (tightest-pair CLIP ' +
      'similarity, 0–1) is at/above `threshold / 100`. Confidence is now a ' +
      'PERSISTED column, so eligibility is a real SQL predicate and the old ' +
      '500-group cap is gone; the run is cancellable and resumable across ' +
      'reloads. For each eligible group the run keeps its suggested-best item ' +
      'and applies the chosen `action` to the remaining live members: `archive` ' +
      'sets archivedAt, `trash` soft-deletes (sets deletedAt). Groups whose ' +
      'confidence is null (uncomputable) are excluded. Requires media:write; ' +
      '`action: "trash"` additionally requires media:delete. Poll ' +
      'GET /api/review-runs/:id for progress.',
  })
  @ApiResponse({
    status: 200,
    description: 'Review run started; `data` is `{ runId, status, matchedCount }`',
  })
  @ApiResponse({
    status: 409,
    description: 'A duplicate review run is already in progress for this circle',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body or missing media:delete for trash',
  })
  @ApiResponse({ status: 404, description: 'Circle not found or access denied' })
  async bulkResolveDuplicateGroupsByThreshold(
    @Body() dto: BulkResolveDuplicateThresholdDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.bulkResolveDuplicateGroupsByThreshold(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/duplicates/bulk/dismiss-by-threshold
   * Bulk-dismiss every pending duplicate group whose read-time confidence is
   * strictly below the given threshold (0–100), ungrouping members without
   * archiving/trashing.
   *
   * IMPORTANT: declared BEFORE `duplicates/:id` routes so the static `bulk`
   * segment is not captured by the `:id` param.
   */
  @Post('duplicates/bulk/dismiss-by-threshold')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a run dismissing duplicate groups below a confidence threshold',
    description:
      'Starts an ASYNC review run (issue #190) that dismisses every pending ' +
      'duplicate group in the circle whose persisted `confidence` (0–1) is ' +
      'strictly below `threshold / 100` — uncapped, cancellable and resumable. ' +
      'Each eligible group is ungrouped (members return to the pool) and marked ' +
      'dismissed — nothing is archived or trashed, so this never requires ' +
      'media:delete. Groups whose confidence is null (uncomputable) are ' +
      'excluded. Requires media:write. Poll GET /api/review-runs/:id for progress.',
  })
  @ApiResponse({
    status: 200,
    description: 'Review run started; `data` is `{ runId, status, matchedCount }`',
  })
  @ApiResponse({
    status: 409,
    description: 'A duplicate review run is already in progress for this circle',
  })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 404, description: 'Circle not found or access denied' })
  async bulkDismissDuplicateGroupsByThreshold(
    @Body() dto: BulkDismissDuplicateThresholdDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.duplicateService.bulkDismissDuplicateGroupsByThreshold(dto, user.id, user.permissions);
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
    return this.duplicateService.rerunDuplicateDetection(id, user.id, user.permissions);
  }
}
