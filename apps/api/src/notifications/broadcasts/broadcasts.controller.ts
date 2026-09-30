import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { BROADCAST_STATUSES, BROADCAST_STATUS_RECHECK_INTERVAL } from './broadcast-constants';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastListQueryDto } from './dto/broadcast-list-query.dto';
import {
  BroadcastAudienceDto,
  BroadcastDto,
  BroadcastListDto,
  BroadcastListResponse,
  BroadcastResponse,
  BroadcastTestResult,
  BroadcastTestResultDto,
} from './dto/broadcast-response.dto';
import { CreateBroadcastDto, TestBroadcastDto } from './dto/create-broadcast.dto';

/**
 * Admin notification broadcasts (epic #481, issue #488).
 *
 * Admin role + broadcasts:read / broadcasts:write. The literal routes
 * (`audience`, `test`) are declared BEFORE `:id` so they are never captured
 * by the parameterised route.
 */
@ApiTags('Notification Broadcasts')
@Controller('admin/broadcasts')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get('audience')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({
    summary: 'Count the users a broadcast would reach',
    description:
      'Active users as of now, counted with the same predicate the fan-out pages with. For a ' +
      'scheduled broadcast this is an estimate: the real audience is frozen when sending begins.',
  })
  @ApiDataResponse(BroadcastAudienceDto, { description: 'Current audience size' })
  audience(): Promise<{ activeUsers: number }> {
    return this.broadcasts.audience();
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send this composition to yourself',
    description:
      'Delivers the composition to the CALLING USER ONLY over the selected channels, through the ' +
      'same delivery path a real send uses. Writes no broadcast row and queues no job. There is ' +
      'no recipient parameter by design. `email` reports the email outcome (null when not selected).',
  })
  @ApiDataResponse(BroadcastTestResultDto, { description: 'What was delivered' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  test(
    @Body() dto: TestBroadcastDto,
    @CurrentUser('id') adminUserId: string,
  ): Promise<BroadcastTestResult> {
    return this.broadcasts.sendTest(dto, adminUserId);
  }

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({ summary: 'List broadcasts (newest first, paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiQuery({ name: 'status', required: false, enum: BROADCAST_STATUSES })
  @ApiDataResponse(BroadcastListDto, { description: 'Paginated broadcasts' })
  list(@Query() query: BroadcastListQueryDto): Promise<BroadcastListResponse> {
    return this.broadcasts.list(query);
  }

  @Post()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @ApiOperation({
    summary: 'Create and queue a broadcast',
    description:
      'Records the broadcast as `scheduled` and queues its fan-out. Omit `scheduledFor` to send ' +
      'now; a future ISO timestamp schedules it durably. `body` is plain text. `channels` is a ' +
      'non-empty subset of `inbox`, `push`, `email`; `push` requires `inbox`; `critical` requires ' +
      '`inbox` and makes the in-app notification mandatory (it bypasses every mute). `link` must ' +
      'be a root-relative path; `ctaLabel` requires `link`.',
  })
  @ApiDataResponse(BroadcastDto, { status: 201, description: 'The queued broadcast' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(
    @Body() dto: CreateBroadcastDto,
    @CurrentUser('id') adminUserId: string,
  ): Promise<BroadcastResponse> {
    return this.broadcasts.create(dto, adminUserId);
  }

  @Get(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({ summary: 'Get one broadcast (progress: recipientCount / processedCount)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(BroadcastDto, { description: 'The broadcast' })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BroadcastResponse> {
    return this.broadcasts.get(id);
  }

  @Post(':id/cancel')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a scheduled, sending or failed broadcast',
    description:
      `A conditional write racing the fan-out in the database. Cancelling a \`sending\` broadcast ` +
      `stops it within ${BROADCAST_STATUS_RECHECK_INTERVAL} further recipients; what was already ` +
      'delivered stays delivered. The row is kept. 409 for `sent`/`canceled`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(BroadcastDto, { description: 'The cancelled broadcast' })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  @ApiResponse({ status: 409, description: 'Not scheduled, sending or failed' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string,
  ): Promise<BroadcastResponse> {
    return this.broadcasts.cancel(id, adminUserId);
  }

  @Post(':id/resume')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a failed broadcast',
    description:
      'A broadcast becomes `failed` when a fan-out job gives up permanently (`lastError` says ' +
      'why). Resume continues from the persisted cursor — recipients already reached are not ' +
      're-sent (beyond one in-flight group). 409 unless `failed`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(BroadcastDto, { description: 'The resumed broadcast' })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  @ApiResponse({ status: 409, description: 'The broadcast is not failed' })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string,
  ): Promise<BroadcastResponse> {
    return this.broadcasts.resume(id, adminUserId);
  }

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a broadcast',
    description: 'Refused with 409 while `sending` — cancel first. Notifications already delivered are kept.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Broadcast deleted' })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  @ApiResponse({ status: 409, description: 'The broadcast is currently sending' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string,
  ): Promise<void> {
    await this.broadcasts.remove(id, adminUserId);
  }
}
