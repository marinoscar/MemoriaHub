import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Notification, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationItemDto } from './dto/notification-response.dto';
import { NotificationPolicyService, isPushAllowed, isToastAllowed } from './notification-policy.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { describeThrown } from './push/describe-thrown';
import { PushConfigService } from './push/push-config.service';
import { PushNotificationChannel } from './push/push-notification.channel';

// =============================================================================
// NotificationDispatchService — the non-inbox channel fan-out (epic #481, #484)
// =============================================================================
//
// NotificationsService writes the inbox row (its three primitives are
// unchanged); once that write has COMMITTED it hands the row here, and this
// service decides which other channels it travels over. Today: Web Push, plus
// an in-process event (`notification.dispatched`) a later SSE stream publishes
// to open tabs.
//
// CALL CONTRACT: `dispatch()` is fire-and-forget. It returns void
// synchronously, never throws, and its background promise never rejects — a
// push provider being down must not be able to fail, slow, or roll back the
// action that produced the notification. It is only ever called AFTER the
// producer's write (and any $transaction around it) has committed.
//
// ORDER (cheapest gate first):
//   1. admin policy        — pushEnabled / disabledTypes (NotificationPolicyService)
//   2. user push pref      — notifications.push.{enabled,types}
//   3. throttle            — at most one push per notification id per 5 min, so a
//                            counted row incremented 4 000 times by an import
//                            produces a handful of pushes, not 4 000
//   4. VAPID active + at least one subscription
//   5. send, then record a NotificationDelivery row (queued → sent|failed)
//
// SHUTDOWN: in-flight dispatches are tracked and drained (bounded, 5 s) in
// onModuleDestroy, so a deploy does not cut a half-written delivery row.
// =============================================================================

/** EventEmitter2 event name published after every dispatch decision. */
export const NOTIFICATION_DISPATCHED_EVENT = 'notification.dispatched';

/** Why the row is being dispatched. */
export type NotificationDispatchReason = 'created' | 'reunread' | 'incremented';

/** Payload of {@link NOTIFICATION_DISPATCHED_EVENT}. */
export interface NotificationDispatchedEvent {
  userId: string;
  notification: NotificationItemDto;
  reason: NotificationDispatchReason;
  /** A push was attempted AND accepted by at least one endpoint. */
  pushed: boolean;
  /** Admin policy allows an in-page browser toast for this type. */
  toast: boolean;
}

/**
 * Per-dispatch narrowing. It can only REMOVE a channel, never add one past
 * policy or preferences — e.g. an admin broadcast sent without the push
 * channel (issue #488).
 */
export interface NotificationDispatchOptions {
  skipPush?: boolean;
}

export const PUSH_THROTTLE_MS = 5 * 60 * 1000;
const PUSH_THROTTLE_MAX_ENTRIES = 10_000;
const DRAIN_TIMEOUT_MS = 5_000;

@Injectable()
export class NotificationDispatchService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatchService.name);

  /** notification id → last push attempt (ms). Bounded; see pruneThrottle(). */
  private readonly lastPushAt = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: NotificationPolicyService,
    private readonly preferences: NotificationPreferencesService,
    private readonly pushConfig: PushConfigService,
    private readonly pushChannel: PushNotificationChannel,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Fan a committed notification row out to its non-inbox channels.
   * Fire-and-forget: returns immediately, never throws, never rejects.
   */
  dispatch(
    row: Notification,
    reason: NotificationDispatchReason = 'created',
    options: NotificationDispatchOptions = {},
  ): void {
    let promise: Promise<void>;
    try {
      promise = this.run(row, reason, options).catch((err) => {
        this.logger.warn(`dispatch(${row.type} ${row.id}) failed: ${describeThrown(err)}`);
      });
    } catch (err) {
      // run() is async so this is belt and braces against a synchronous throw.
      this.logger.warn(`dispatch(${row.type} ${row.id}) failed: ${describeThrown(err)}`);
      return;
    }
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  /** Does this user have at least one registered push subscription? */
  async hasActivePushSubscription(userId: string): Promise<boolean> {
    try {
      return (await this.prisma.pushSubscription.count({ where: { userId } })) > 0;
    } catch {
      return false;
    }
  }

  /** Wait (bounded) for in-flight dispatches — shutdown and tests. */
  async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async run(
    row: Notification,
    reason: NotificationDispatchReason,
    options: NotificationDispatchOptions,
  ): Promise<void> {
    const policy = await this.policy.getPolicy();
    const toast = isToastAllowed(row.type, policy);
    let pushed = false;

    if (
      !options.skipPush &&
      isPushAllowed(row.type, policy) &&
      (await this.preferences.isPushEnabled(row.userId, row.type))
    ) {
      pushed = await this.push(row);
    }

    this.publish({ userId: row.userId, notification: toItem(row), reason, pushed, toast });
  }

  /** Throttle → VAPID → subscriptions → send → delivery row. Returns `pushed`. */
  private async push(row: Notification): Promise<boolean> {
    const now = Date.now();
    const last = this.lastPushAt.get(row.id);
    if (last !== undefined && now - last < PUSH_THROTTLE_MS) return false;

    // Claim the throttle slot SYNCHRONOUSLY, before any await: a burst of
    // concurrent increments of the same row must see the claim, or every one
    // of them would pass the check above before the first stamps it.
    this.pruneThrottle(now);
    this.lastPushAt.set(row.id, now);

    const vapid = await this.pushConfig.resolveActiveVapidConfig();
    if (!vapid || !(await this.hasActivePushSubscription(row.userId))) {
      // Nothing was sent — release the slot so a push becomes possible the
      // moment the user subscribes (or an admin enables push).
      if (this.lastPushAt.get(row.id) === now) this.lastPushAt.delete(row.id);
      return false;
    }

    const delivery = await this.prisma.notificationDelivery
      .create({
        data: {
          notificationId: row.id,
          userId: row.userId,
          type: row.type,
          channel: 'push',
          status: 'queued',
        },
        select: { id: true },
      })
      .catch((err) => {
        this.logger.warn(`Could not record push delivery for ${row.id}: ${describeThrown(err)}`);
        return null;
      });

    const result = await this.pushChannel.deliver(row, vapid);

    if (delivery) {
      const summary = `${result.sent}/${result.attempted} sent, ${result.failed} failed, ${result.pruned} pruned`;
      await this.prisma.notificationDelivery
        .update({
          where: { id: delivery.id },
          data: {
            status: result.success ? 'sent' : 'failed',
            providerMessageId: result.success ? summary : null,
            error: result.success ? null : (result.error ?? summary).slice(0, 1000),
          } satisfies Prisma.NotificationDeliveryUpdateInput,
        })
        .catch((err) =>
          this.logger.warn(`Could not finalize push delivery ${delivery.id}: ${describeThrown(err)}`),
        );
    }

    return result.success;
  }

  private publish(event: NotificationDispatchedEvent): void {
    if (!this.events) return;
    try {
      this.events.emit(NOTIFICATION_DISPATCHED_EVENT, event);
    } catch (err) {
      // A listener throwing synchronously must not escape into dispatch().
      this.logger.warn(`${NOTIFICATION_DISPATCHED_EVENT} listener failed: ${describeThrown(err)}`);
    }
  }

  private pruneThrottle(now: number): void {
    if (this.lastPushAt.size < PUSH_THROTTLE_MAX_ENTRIES) return;
    for (const [id, at] of this.lastPushAt) {
      if (now - at >= PUSH_THROTTLE_MS) this.lastPushAt.delete(id);
    }
    if (this.lastPushAt.size >= PUSH_THROTTLE_MAX_ENTRIES) this.lastPushAt.clear();
  }
}

function toItem(row: Notification): NotificationItemDto {
  return {
    id: row.id,
    circleId: row.circleId,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    data: row.data ?? null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
