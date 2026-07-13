import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ReviewInsightsService } from './review-insights.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

@ApiTags('Review Insights')
@ApiBearerAuth()
@Controller('media')
export class ReviewInsightsController {
  constructor(private readonly reviewInsights: ReviewInsightsService) {}

  /**
   * GET /api/media/review-insights?circleId=
   * Per-circle aggregate of burst + duplicate review activity.
   */
  @Get('review-insights')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
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
    @CurrentUser() user: RequestUser,
  ) {
    return this.reviewInsights.getReviewInsights(circleId, user.id, user.permissions);
  }
}
