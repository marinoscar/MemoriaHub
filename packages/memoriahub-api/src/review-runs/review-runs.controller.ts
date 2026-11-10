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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../media/index.js';
import { ReviewRunService } from './review-run.service.js';
import { ListReviewRunItemsQueryDto } from './review-runs.dto.js';

/**
 * Shared review-queue run inspection + cancel API (issue #190).
 *
 * Serves burst, duplicate and location-suggestion runs alike — the run's own
 * `subjectType` tells the client which queue it belongs to. Runs are STARTED by
 * the per-queue threshold endpoints, never here.
 *
 * Circle-scoped in the service: reads require media:read + per-circle viewer;
 * cancel requires media:write + per-circle collaborator.
 */
/**
 * The `ReviewRunsController` routes; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Review Runs')
@ApiBearerAuth('JWT-auth')
@Controller('review-runs')
/**
 * Review runs controller.
 *
 * @stability experimental
 */
export class ReviewRunsController {
  constructor(private readonly runService: ReviewRunService) {}

  /** Get a review run (counters + item status tally). */
  @Get(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a review run (counters + item status tally)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.getRunDetail(id, user.id, user.permissions);
  }

  /** List a run’s items (paginated, signed thumbnails). */
  @Get(':id/items')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List a run’s items (paginated, signed thumbnails)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Items listed' })
  async items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListReviewRunItemsQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.listRunItems(id, query, user.id, user.permissions);
  }

  /** Cancel a non-terminal review run (collaborator). */
  @Post(':id/cancel')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a non-terminal review run (collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.cancelRun(id, user.id, user.permissions);
  }
}
