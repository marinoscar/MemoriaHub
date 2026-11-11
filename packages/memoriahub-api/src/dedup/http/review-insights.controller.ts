import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { ReviewInsightsService } from '../review-insights.service.js';
import { DEDUP_PERMISSIONS as PERMISSIONS } from './dedup-permissions.js';

/**
 * The `ReviewInsightsController` route (`GET /api/media/review-insights`); mounted by the host in its own
 * module.
 *
 * @stability experimental
 */
@ApiTags('Review Insights')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class ReviewInsightsController {
  constructor(private readonly reviewInsights: ReviewInsightsService) {}

  /** Per-circle aggregate of burst and duplicate review activity. */
  @Get('review-insights')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Per-circle burst & duplicate review-queue insights',
    description:
      'Returns an on-demand aggregate of burst and duplicate review activity for a ' +
      'circle: groups identified/pending/resolved/dismissed, resolution action ' +
      'breakdown (archive vs. trash), and item-level kept/archived/deleted counts.',
  })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiResponse({ status: 200, description: 'Review insights returned' })
  async getReviewInsights(
    @Query('circleId', new ParseUUIDPipe()) circleId: string,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.reviewInsights.getReviewInsights(circleId, user.id, user.permissions);
  }
}
