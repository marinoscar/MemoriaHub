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
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ReviewRunService } from '../../review-runs/review-run.service';
import { ListLocationSuggestionRunItemsQueryDto } from '../dto/list-location-suggestion-run-items-query.dto';

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
@ApiTags('Location Suggestion Runs (deprecated)')
@ApiBearerAuth('JWT-auth')
@Controller('location-suggestion-runs')
export class LocationSuggestionRunsController {
  constructor(private readonly runService: ReviewRunService) {}

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get a location-suggestion run (deprecated — use GET /review-runs/:id)',
    deprecated: true,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.getRunDetail(id, user.id, user.permissions);
  }

  @Get(':id/items')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
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
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.listRunItems(id, query, user.id, user.permissions);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a non-terminal run (deprecated — use POST /review-runs/:id/cancel)',
    deprecated: true,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.cancelRun(id, user.id, user.permissions);
  }
}
