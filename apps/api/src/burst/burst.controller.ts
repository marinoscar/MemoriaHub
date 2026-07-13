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
import { BurstService } from './burst.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { BurstQueryDto } from './dto/burst-query.dto';
import { ResolveBurstDto } from './dto/resolve-burst.dto';

@ApiTags('Bursts')
@ApiBearerAuth()
@Controller('media')
export class BurstController {
  constructor(private readonly burstService: BurstService) {}

  /**
   * GET /api/media/bursts
   * List burst groups for a circle, filtered by status.
   */
  @Get('bursts')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List burst groups for a circle' })
  @ApiQuery({ name: 'circleId', type: String, required: true })
  @ApiQuery({ name: 'status', type: String, required: false, enum: ['pending', 'resolved', 'dismissed'] })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Burst groups listed' })
  async listBurstGroups(
    @Query() query: BurstQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.burstService.listBurstGroups(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/bursts/:id
   * Get full detail for a single burst group.
   */
  @Get('bursts/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get burst group detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Burst group returned' })
  @ApiResponse({ status: 404, description: 'Burst group not found' })
  async getBurstGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.burstService.getBurstGroup(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/:id/resolve
   * Resolve a burst group, soft-deleting all non-kept members.
   */
  @Post('bursts/:id/resolve')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
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
    @CurrentUser() user: RequestUser,
  ) {
    return this.burstService.resolveBurstGroup(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bursts/:id/dismiss
   * Dismiss a burst group (not actually a burst; ungroups all members).
   */
  @Post('bursts/:id/dismiss')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a burst group (not a burst)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Burst group dismissed' })
  @ApiResponse({ status: 400, description: 'Group is not in pending status' })
  @ApiResponse({ status: 404, description: 'Burst group not found' })
  async dismissBurstGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.burstService.dismissBurstGroup(id, user.id, user.permissions);
  }
}
