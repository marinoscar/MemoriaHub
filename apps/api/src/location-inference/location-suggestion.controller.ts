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
import { LocationSuggestionService } from './location-suggestion.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkAcceptLocationSuggestionsDto } from './dto/bulk-accept-location-suggestions.dto';

@ApiTags('Location Inference')
@ApiBearerAuth()
@Controller('media')
export class LocationSuggestionController {
  constructor(private readonly locationSuggestionService: LocationSuggestionService) {}

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
  @ApiResponse({ status: 200, description: 'Location suggestions listed' })
  async listSuggestions(@Query() query: LocationSuggestionQueryDto, @CurrentUser() user: RequestUser) {
    return this.locationSuggestionService.listSuggestions(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/location-suggestions/bulk-accept
   * Accept all pending suggestions in a circle at or above a confidence floor.
   */
  @Post('location-suggestions/bulk-accept')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-accept pending location suggestions above a confidence threshold' })
  @ApiResponse({ status: 200, description: 'Suggestions accepted' })
  async bulkAcceptSuggestions(
    @Body() dto: BulkAcceptLocationSuggestionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.locationSuggestionService.bulkAcceptSuggestions(dto, user.id, user.permissions);
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
