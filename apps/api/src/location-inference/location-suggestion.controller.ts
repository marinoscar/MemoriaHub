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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LocationSuggestionRunAction } from '@prisma/client';
import { LocationSuggestionService } from './location-suggestion.service';
import { LocationSuggestionRunService } from './runs/location-suggestion-run.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkResolveLocationSuggestionsDto } from './dto/bulk-resolve-location-suggestions.dto';

@ApiTags('Location Inference')
@ApiBearerAuth()
@Controller('media')
export class LocationSuggestionController {
  constructor(
    private readonly locationSuggestionService: LocationSuggestionService,
    private readonly runService: LocationSuggestionRunService,
  ) {}

  /**
   * GET /api/media/location-suggestions
   * List location suggestions (review queue) for a circle.
   */
  @Get('location-suggestions')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List location suggestions for a circle' })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiQuery({
    name: 'status',
    type: String,
    required: false,
    enum: ['pending', 'accepted', 'rejected', 'auto_applied', 'reverted'],
  })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiQuery({ name: 'mediaItemId', type: String, required: false, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Location suggestions listed' })
  async listSuggestions(@Query() query: LocationSuggestionQueryDto, @CurrentUser() user: RequestUser) {
    return this.locationSuggestionService.listSuggestions(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/location-suggestions/bulk-accept
   * Start an async run that accepts every pending suggestion in a circle at or
   * above a confidence threshold (0-100). Returns immediately; matchedCount is 0
   * at creation and reflects the real total once the run is evaluated.
   */
  @Post('location-suggestions/bulk-accept')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start an async bulk-accept run for pending location suggestions above a threshold' })
  @ApiResponse({ status: 200, description: 'Bulk-accept run started' })
  @ApiResponse({ status: 409, description: 'A run is already in progress for this circle' })
  async bulkAcceptSuggestions(
    @Body() dto: BulkResolveLocationSuggestionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.runService.createRun(
      dto.circleId,
      LocationSuggestionRunAction.accept,
      dto.threshold,
      user.id,
      user.permissions,
    );
    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
  }

  /**
   * POST /api/media/location-suggestions/bulk-reject
   * Start an async run that rejects every pending suggestion in a circle at or
   * above a confidence threshold (0-100).
   */
  @Post('location-suggestions/bulk-reject')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start an async bulk-reject run for pending location suggestions above a threshold' })
  @ApiResponse({ status: 200, description: 'Bulk-reject run started' })
  @ApiResponse({ status: 409, description: 'A run is already in progress for this circle' })
  async bulkRejectSuggestions(
    @Body() dto: BulkResolveLocationSuggestionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.runService.createRun(
      dto.circleId,
      LocationSuggestionRunAction.reject,
      dto.threshold,
      user.id,
      user.permissions,
    );
    return { data: { runId: run.id, status: run.status, matchedCount: run.matchedCount } };
  }

  /**
   * POST /api/media/location-suggestions/:id/accept
   */
  @Post('location-suggestions/:id/accept')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a location suggestion (optionally adjusting lat/lng)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Suggestion accepted' })
  @ApiResponse({ status: 400, description: 'Suggestion is not pending' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async acceptSuggestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptLocationSuggestionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.locationSuggestionService.acceptSuggestion(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/location-suggestions/:id/reject
   */
  @Post('location-suggestions/:id/reject')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a location suggestion' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Suggestion rejected' })
  @ApiResponse({ status: 400, description: 'Suggestion is not pending' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async rejectSuggestion(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.locationSuggestionService.rejectSuggestion(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/location-suggestions/:id/revert
   */
  @Post('location-suggestions/:id/revert')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revert an auto-applied location suggestion' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Suggestion reverted' })
  @ApiResponse({ status: 400, description: 'Suggestion is not auto_applied' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async revertSuggestion(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.locationSuggestionService.revertSuggestion(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/:id/infer-location
   * Force a fresh location-inference rerun for a single media item.
   */
  @Post(':id/infer-location')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Re-run location inference for a media item' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Location inference job queued' })
  async inferLocation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.locationSuggestionService.inferLocation(id, user.id, user.permissions);
  }
}
