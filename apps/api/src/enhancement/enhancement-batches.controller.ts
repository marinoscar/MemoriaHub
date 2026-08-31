import {
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
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { MediaEnhancementService } from './media-enhancement.service';
import { ListEnhancementBatchesQueryDto } from './dto/list-enhancement-batches-query.dto';

/**
 * Bulk AI enhancement — batch inspection + cancel API (epic #420, issue #421).
 *
 * Circle-scoped in the service. Reads require media:read + per-circle viewer;
 * cancel requires media:write + per-circle collaborator. No new RBAC permission:
 * a batch is just a grouping over enhancements the caller can already act on.
 *
 * The detail payload is deliberately BaseRun-shaped (the same field set as
 * trash-empty runs, workflow runs and review runs) so the web RunProgressPanel
 * and useRunPolling drive it with no new component.
 */
@ApiTags('Picture Enhancement')
@ApiBearerAuth('JWT-auth')
@Controller('enhancement-batches')
export class EnhancementBatchesController {
  constructor(private readonly service: MediaEnhancementService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: "List a circle's bulk-enhancement batches (paginated, newest first)",
    description:
      'Each item carries the same derived counters as the detail endpoint. Every counter is ' +
      'computed live from the batch\'s enhancement rows — batches store no counter columns — ' +
      'so a count can never drift from the rows it describes.',
  })
  @ApiQuery({
    name: 'circleId',
    required: true,
    type: String,
    format: 'uuid',
    description: 'Circle to list batches for',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Default 1' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: 'Default 20, max 50',
  })
  @ApiResponse({ status: 200, description: 'Paginated batch list with { items, meta }' })
  @ApiResponse({ status: 400, description: 'Invalid query params' })
  @ApiResponse({ status: 403, description: 'Caller is not a viewer of the circle' })
  async list(
    @Query() query: ListEnhancementBatchesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listBatches(query, user);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get a bulk-enhancement batch (progress counters)',
    description:
      'Returns the shared async-run shape: { id, circleId, status, matchedCount, ' +
      'processedCount, succeededCount, failedCount, skippedCount, startedById, createdAt, ' +
      'updatedAt, startedAt, finishedAt, lastError }, plus the batch-specific ' +
      'requestedCount / queuedCount / skipped / params / source / cancelledAt. ' +
      '`succeededCount` counts every row whose render completed (ready, applied, discarded, ' +
      'expired); `skippedCount` counts rows withdrawn by a cancel before any render ran. ' +
      '`status` is terminal as soon as no rows remain pending or processing — a batch that ' +
      'queued nothing reads `completed`, never a stuck `running`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Batch returned' })
  @ApiResponse({ status: 403, description: 'Caller is not a viewer of the circle' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.service.getBatch(id, user);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a non-terminal bulk-enhancement batch (collaborator)',
    description:
      'Withdraws every enhancement still queued: its pending job row is deleted and the row ' +
      'is marked `cancelled`. An enhancement already PROCESSING is deliberately left to ' +
      'finish — its model call is already billed, so aborting spends the money and discards ' +
      'the result. Returns { batchId, status, cancelled } where `cancelled` is the number of ' +
      'pending enhancements withdrawn.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Batch cancelled' })
  @ApiResponse({ status: 400, description: 'Batch already finished' })
  @ApiResponse({ status: 403, description: 'Caller is not a collaborator of the circle' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.service.cancelBatch(id, user);
  }
}
