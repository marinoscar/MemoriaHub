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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../media/index.js';
import { BurstService } from './burst.service.js';
import {
  BulkDismissBurstThresholdDto,
  BulkResolveBurstDto,
  BulkResolveBurstThresholdDto,
  BurstQueryDto,
  ResolveBurstDto,
} from './burst.dto.js';

/**
 * The `BurstController` routes (review queue); mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Bursts')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class BurstController {
  constructor(private readonly burstService: BurstService) {}

  /**
   * GET /api/media/bursts
   * List burst groups for a circle, filtered by status.
   */
  @Get('bursts')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List burst groups for a circle' })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiQuery({ name: 'status', type: String, required: false, enum: ['pending', 'resolved', 'dismissed'] })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiQuery({ name: 'sortBy', type: String, required: false, enum: ['capturedAt', 'confidence', 'mediaCount'] })
  @ApiQuery({ name: 'sortOrder', type: String, required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Burst groups listed' })
  async listBurstGroups(
    @Query() query: BurstQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.listBurstGroups(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/bulk/resolve
   * Bulk-resolve multiple burst groups, auto-keeping each group's suggested-best
   * item and applying the chosen action to the rest.
   *
   * IMPORTANT: declared BEFORE `bursts/:id` routes so the static `bulk` segment
   * is not captured by the `:id` param.
   */
  @Post('bursts/bulk/resolve')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-resolve burst groups (auto-keep suggested best, archive or trash the rest)',
    description:
      'Resolves 1–100 burst groups at once. For each pending group, keeps its ' +
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
  async bulkResolveBurstGroups(
    @Body() dto: BulkResolveBurstDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.bulkResolveBurstGroups(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/bulk/resolve-by-threshold
   * Bulk-resolve every pending burst group whose confidence is at/above the
   * given threshold (0–100), auto-keeping each group's suggested-best item.
   *
   * IMPORTANT: declared BEFORE `bursts/:id` routes so the static `bulk` segment
   * is not captured by the `:id` param.
   */
  @Post('bursts/bulk/resolve-by-threshold')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a run resolving burst groups at/above a confidence threshold',
    description:
      'Starts an ASYNC review run (issue #190) that resolves every pending burst ' +
      'group in the circle whose `confidence` (0–1) is at/above `threshold / 100` ' +
      '— uncapped, cancellable and resumable across reloads. For each eligible ' +
      'group the run keeps its suggested-best item and applies the chosen ' +
      '`action` to the remaining live members: `archive` sets archivedAt, `trash` ' +
      'soft-deletes (sets deletedAt). Legacy groups with null confidence are ' +
      'excluded. Requires media:write; `action: "trash"` additionally requires media:delete. ' +
      'Returns immediately with `{ runId, status, matchedCount }` (`matchedCount` ' +
      'is 0 at creation and reflects the real total once evaluated); poll ' +
      'GET /api/review-runs/:id for progress.',
  })
  @ApiResponse({
    status: 200,
    description: 'Review run started; `data` is `{ runId, status, matchedCount }`',
  })
  @ApiResponse({
    status: 409,
    description: 'A burst review run is already in progress for this circle',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body or missing media:delete for trash',
  })
  @ApiResponse({ status: 404, description: 'Circle not found or access denied' })
  async bulkResolveBurstGroupsByThreshold(
    @Body() dto: BulkResolveBurstThresholdDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.bulkResolveBurstGroupsByThreshold(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/bulk/dismiss-by-threshold
   * Bulk-dismiss every pending burst group whose confidence is strictly below
   * the given threshold (0–100), ungrouping members without archiving/trashing.
   *
   * IMPORTANT: declared BEFORE `bursts/:id` routes so the static `bulk` segment
   * is not captured by the `:id` param.
   */
  @Post('bursts/bulk/dismiss-by-threshold')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a run dismissing burst groups below a confidence threshold',
    description:
      'Starts an ASYNC review run (issue #190) that dismisses every pending burst ' +
      'group in the circle whose `confidence` (0–1) is strictly below ' +
      '`threshold / 100` — uncapped, cancellable and resumable. Each eligible ' +
      'group is ungrouped (members return to the pool) and marked dismissed — ' +
      'nothing is archived or trashed, so this never requires media:delete. ' +
      'Legacy groups with null confidence are excluded. Requires media:write. ' +
      'Poll GET /api/review-runs/:id for progress.',
  })
  @ApiResponse({
    status: 200,
    description: 'Review run started; `data` is `{ runId, status, matchedCount }`',
  })
  @ApiResponse({
    status: 409,
    description: 'A burst review run is already in progress for this circle',
  })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 404, description: 'Circle not found or access denied' })
  async bulkDismissBurstGroupsByThreshold(
    @Body() dto: BulkDismissBurstThresholdDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.bulkDismissBurstGroupsByThreshold(dto, user.id, user.permissions);
  }

  /**
   * GET /api/media/bursts/:id
   * Get full detail for a single burst group.
   */
  @Get('bursts/:id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get burst group detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Burst group returned' })
  @ApiResponse({ status: 404, description: 'Burst group not found' })
  async getBurstGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.getBurstGroup(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/:id/resolve
   * Resolve a burst group, soft-deleting all non-kept members.
   */
  @Post('bursts/:id/resolve')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a burst group (keep selected, archive or trash the rest)',
    description:
      'Keeps the selected members and applies the chosen `action` to the rest: ' +
      '`archive` sets archivedAt, `trash` soft-deletes (sets deletedAt). ' +
      'Requires media:write; `action: "trash"` additionally requires media:delete.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Burst group resolved' })
  @ApiResponse({ status: 400, description: 'Invalid keepIds or group not pending' })
  @ApiResponse({ status: 404, description: 'Burst group not found' })
  async resolveBurstGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBurstDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.resolveBurstGroup(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/:id/dismiss
   * Dismiss a burst group (not actually a burst; ungroups all members).
   */
  @Post('bursts/:id/dismiss')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a burst group (not a burst)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Burst group dismissed' })
  @ApiResponse({ status: 400, description: 'Group is not in pending status' })
  @ApiResponse({ status: 404, description: 'Burst group not found' })
  async dismissBurstGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.burstService.dismissBurstGroup(id, user.id, user.permissions);
  }
}
