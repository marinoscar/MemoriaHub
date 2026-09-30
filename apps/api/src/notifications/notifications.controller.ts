import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotificationListQueryDto } from './dto/notification-query.dto';
import {
  BulkResultDto,
  NotificationListDto,
  UnreadCountDto,
} from './dto/notification-response.dto';
import { NotificationScopeDto } from './dto/notification-scope.dto';
import { pushCapableTypes } from './notification-channels';
import { NotificationPolicyService, isPushAllowed } from './notification-policy.service';
import { NotificationsService } from './notifications.service';
import {
  PushSubscribeDto,
  PushSubscriptionResponse,
  PushUnsubscribeDto,
} from './push/dto/push-subscription.dto';
import { PushConfigService } from './push/push-config.service';
import { PushSubscriptionService } from './push/push-subscription.service';

/** GET /api/notifications/config — what a client needs to offer push. */
export interface NotificationClientConfig {
  /** An active VAPID key pair exists: the client may subscribe. */
  pushEnabled: boolean;
  /** The applicationServerKey for pushManager.subscribe, null when push is off. */
  vapidPublicKey: string | null;
  /** May the client raise in-page browser toasts at all? (admin kill switch) */
  browserEnabled: boolean;
  /**
   * Types the admin policy lets travel by push — what a per-type push
   * preference toggle should be offered for. Empty when push is off.
   */
  pushTypes: NotificationType[];
}

/**
 * Notification Center API (epic #240, issue #245).
 *
 * AUTH: every handler carries a BARE `@Auth()` — authenticated, any role, no
 * permission. There is no new RBAC permission for notifications, deliberately:
 * a notification is inherently personal and every route is already scoped to
 * `@CurrentUser('id')`, so there is nothing an Admin-gated permission would
 * protect. Same least-privilege rationale as `GET /api/features`.
 *
 * The bare `@Auth()` is NOT optional. This codebase has no APP_GUARD — routes
 * are not authenticated by default, so an undecorated handler here would be
 * publicly reachable.
 *
 * Every `:id` route scopes its WHERE by both `id` AND the JWT's `userId`, so a
 * cross-user id yields 404 rather than 403 (enumeration-resistant).
 */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushConfig: PushConfigService,
    private readonly pushSubscriptions: PushSubscriptionService,
    private readonly policy: NotificationPolicyService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/notifications
  // ---------------------------------------------------------------------------

  @Get()
  @Auth()
  @ApiOperation({
    summary: "List the current user's notifications (paginated, newest first)",
    description:
      'Dismissed rows are EXCLUDED from status=unread|read|all and are returned ' +
      'ONLY by status=dismissed.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['unread', 'read', 'all', 'dismissed'],
    description: 'Defaults to "all" (every live, non-dismissed row).',
  })
  @ApiQuery({ name: 'circleId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiResponse({
    status: 200,
    description: 'Paginated notifications',
    type: NotificationListDto,
  })
  async list(
    @Query() query: NotificationListQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<NotificationListDto> {
    return this.notificationsService.list(userId, query);
  }

  // ---------------------------------------------------------------------------
  // GET /api/notifications/config  (before :id to avoid route conflicts)
  // ---------------------------------------------------------------------------

  @Get('config')
  @Auth()
  @ApiOperation({
    summary: 'Client notification capabilities (Web Push availability and key)',
    description:
      'Authentication only, no permission: the users push reaches are exactly the users ' +
      'who cannot read system settings. Exposes the VAPID PUBLIC key only.',
  })
  @ApiResponse({ status: 200, description: 'Notification capabilities' })
  async config(): Promise<NotificationClientConfig> {
    const [publicKey, policy] = await Promise.all([
      this.pushConfig.getActivePublicKey(),
      this.policy.getPolicy(),
    ]);
    // The admin kill switch hides push entirely, so a client never spends the
    // one-shot browser permission prompt on a channel that cannot deliver.
    const pushEnabled = publicKey !== null && policy.pushEnabled;
    return {
      pushEnabled,
      vapidPublicKey: pushEnabled ? publicKey : null,
      browserEnabled: policy.browserEnabled,
      pushTypes: pushEnabled ? pushCapableTypes().filter((t) => isPushAllowed(t, policy)) : [],
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/notifications/push/subscriptions
  // ---------------------------------------------------------------------------

  @Post('push/subscriptions')
  @Auth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Register this browser's Web Push subscription",
    description:
      "Body is the browser's `PushSubscription.toJSON()`. Upserted by endpoint: a " +
      'subscription re-registered under another signed-in user moves to that user. ' +
      '409 when Web Push is not enabled on this deployment.',
  })
  @ApiResponse({ status: 201, description: 'Subscription stored' })
  @ApiResponse({ status: 409, description: 'Web Push is not enabled' })
  async subscribePush(
    @Body() dto: PushSubscribeDto,
    @CurrentUser('id') userId: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PushSubscriptionResponse> {
    return this.pushSubscriptions.subscribe(userId, dto, userAgent);
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/notifications/push/subscriptions
  // ---------------------------------------------------------------------------

  @Delete('push/subscriptions')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Remove one of the caller's Web Push subscriptions",
    description: 'Body `{ endpoint }`. Scoped to the caller: another user\'s endpoint is a 404.',
  })
  @ApiResponse({ status: 204, description: 'Subscription removed' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async unsubscribePush(
    @Body() dto: PushUnsubscribeDto,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.pushSubscriptions.unsubscribe(userId, dto.endpoint);
  }

  // ---------------------------------------------------------------------------
  // GET /api/notifications/unread-count  (before :id to avoid route conflicts)
  // ---------------------------------------------------------------------------

  @Get('unread-count')
  @Auth()
  @ApiOperation({
    summary: 'Unread notification count for the bell badge',
    description:
      'Live (non-dismissed), never-read rows across all circles. Cached ' +
      'per user for ~2 s and invalidated immediately on any mutation by that user.',
  })
  @ApiResponse({ status: 200, description: 'Unread count', type: UnreadCountDto })
  async unreadCount(@CurrentUser('id') userId: string): Promise<UnreadCountDto> {
    return this.notificationsService.getUnreadCount(userId);
  }

  // ---------------------------------------------------------------------------
  // POST /api/notifications/read-all  (before :id to avoid route conflicts)
  // ---------------------------------------------------------------------------

  @Post('read-all')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark every unread notification read',
    description:
      'Optional { circleId } scopes the operation to one circle. Rows carrying ' +
      'data.count also get data.countAtRead snapshotted to the current count.',
  })
  @ApiResponse({ status: 200, description: 'Rows updated', type: BulkResultDto })
  async readAll(
    @Body() dto: NotificationScopeDto,
    @CurrentUser('id') userId: string,
  ): Promise<BulkResultDto> {
    return this.notificationsService.markAllRead(userId, dto?.circleId);
  }

  // ---------------------------------------------------------------------------
  // POST /api/notifications/dismiss-all  (before :id to avoid route conflicts)
  // ---------------------------------------------------------------------------

  @Post('dismiss-all')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss every live notification',
    description:
      'Optional { circleId } scopes the operation to one circle. Dismissing ' +
      'implies read.',
  })
  @ApiResponse({ status: 200, description: 'Rows updated', type: BulkResultDto })
  async dismissAll(
    @Body() dto: NotificationScopeDto,
    @CurrentUser('id') userId: string,
  ): Promise<BulkResultDto> {
    return this.notificationsService.dismissAll(userId, dto?.circleId);
  }

  // ---------------------------------------------------------------------------
  // POST /api/notifications/:id/read
  // ---------------------------------------------------------------------------

  @Post(':id/read')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one notification read (idempotent)',
    description:
      'When the row carries data.count, data.countAtRead is snapshotted to the ' +
      'current count.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Notification marked read' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.notificationsService.markRead(userId, id);
  }

  // ---------------------------------------------------------------------------
  // POST /api/notifications/:id/dismiss
  // ---------------------------------------------------------------------------

  @Post(':id/dismiss')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dismiss one notification (idempotent; implies read)',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Notification dismissed' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.notificationsService.dismiss(userId, id);
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/notifications/:id
  // ---------------------------------------------------------------------------

  @Delete(':id')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Hard-delete one notification' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Notification deleted' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.notificationsService.remove(userId, id);
  }
}
