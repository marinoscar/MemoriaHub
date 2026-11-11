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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { ReviewRunService } from '../../review-runs/index.js';
import { LOCATION_PERMISSIONS as PERMISSIONS } from './location-permissions.js';
import { ListLocationSuggestionRunItemsQueryDto } from './location-suggestion.dto.js';

/**
 * DEPRECATED alias for the shared review-run API (issue #190).
 *
 * Location-suggestion runs are now `review_runs` rows with
 * `subjectType='location_suggestion'`, served by
 * `GET/POST /api/review-runs/:id[/items|/cancel]`. The migration preserved run
 * UUIDs, so every previously-issued `/api/location-suggestion-runs/:id` link
 * still resolves — this controller keeps that shipped contract (and
 * docs/specs/location-inference.md §9.6) honoured by delegating straight to
 * `ReviewRunService`.
 *
 * Prefer `/api/review-runs/:id` for new clients.
 */
/**
 * The `LocationSuggestionRunsController` routes (the deprecated `/api/location-suggestion-runs/*` alias);
 * mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Location Suggestion Runs (deprecated)')
@ApiBearerAuth('JWT-auth')
@Controller('location-suggestion-runs')
export class LocationSuggestionRunsController {
  constructor(private readonly runService: ReviewRunService) {}

  /** Gets a run (deprecated alias of the review-run API). */
  @Get(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get a location-suggestion run (deprecated — use GET /review-runs/:id)',
    deprecated: true,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.getRunDetail(id, user.id, user.permissions);
  }

  /** Lists a run's items (deprecated alias of the review-run API). */
  @Get(':id/items')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'List a run’s items (deprecated — use GET /review-runs/:id/items)',
    deprecated: true,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Items listed' })
  async items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationSuggestionRunItemsQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.listRunItems(id, query, user.id, user.permissions);
  }

  /** Cancels a run (deprecated alias of the review-run API). */
  @Post(':id/cancel')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a non-terminal run (deprecated — use POST /review-runs/:id/cancel)',
    deprecated: true,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.cancelRun(id, user.id, user.permissions);
  }
}
