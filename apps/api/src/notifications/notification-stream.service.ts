import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subscriber } from 'rxjs';

import { NotificationItemDto } from './dto/notification-response.dto';
import {
  NOTIFICATION_DISPATCHED_EVENT,
  NotificationDispatchReason,
  NotificationDispatchedEvent,
} from './notification-dispatch.service';
import { NotificationsService } from './notifications.service';

// =============================================================================
// NotificationStreamService — live notifications over SSE (epic #481, #485)
// =============================================================================
//
// A per-process registry of open `GET /api/notifications/stream` connections,
// keyed by user id. NotificationDispatchService emits
// `notification.dispatched` after every committed inbox write; the listener
// below publishes it to that user's open tabs, so the bell updates without
// waiting for the next poll.
//
// PER-USER ISOLATION IS STRUCTURAL, NOT A FILTER. `subscribers` maps a user id
// to that user's own connections and `publish(userId, …)` writes to exactly
// one bucket. There is no method that reaches more than one user, so a leak
// would require publishing under the wrong key — and the key comes from the
// `user_id` of the row that was just written (or, for `sync`, from the JWT of
// the user who just mutated their own rows). A single shared Subject with a
// per-connection `.filter()` was rejected: one deleted predicate away from
// broadcasting everyone's notifications to every tab, with no error anywhere.
//
// PER-PROCESS: with more than one API replica, a tab connected to pod A sees
// nothing published on pod B. That is survivable because the TABLE, not the
// stream, is the source of truth — rows are written before this runs, and the
// client refetches the list and unread count on (re)connect. SSE is a
// liveness nudge, NOT a delivery guarantee: there is no replay buffer and no
// `Last-Event-ID` support, deliberately.
//
// FRAMES (all `data` payloads carry a `type` discriminator):
//   event: notification  data: { type:'notification', notification, unreadCount?, toast, pushed, reason }
//   event: sync          data: { type:'sync' }   — the user's rows changed in another tab
//   event: ping          data: { type:'ping' }   — sent on open and every 25 s
//
// WHY `ping` IS A NAMED EVENT AND NOT AN SSE COMMENT: this Nest version's
// SseStream has no comment support — a `{ comment }` message is written as an
// empty `id:` frame. A named event is explicit on the wire, ignored by any
// client that does not listen for it, and unambiguous for fetch-based parsers
// that might otherwise surface an empty-data frame.
// =============================================================================

/** SSE `event:` name carrying a new / re-unread / incremented notification. */
export const NOTIFICATION_SSE_EVENT = 'notification';

/** SSE `event:` name telling a tab to refetch (read/dismiss/delete elsewhere). */
export const NOTIFICATION_SYNC_SSE_EVENT = 'sync';

/** SSE `event:` name of the keep-alive frame (sent on open and every interval). */
export const NOTIFICATION_PING_SSE_EVENT = 'ping';

/**
 * Keep-alive interval. 25 s sits under the shortest idle timeout in common use
 * (30 s) so no proxy/NAT reaps a healthy stream.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Open connections allowed per user. A user with many tabs is legitimate; a
 * runaway client reconnect loop is not — past the cap the OLDEST connection
 * is completed (it reconnects if still wanted), so memory stays bounded.
 */
export const MAX_CONNECTIONS_PER_USER = 10;

/** `data` of a `notification` frame. */
export interface NotificationStreamFrame {
  type: 'notification';
  /** Same shape `GET /api/notifications` returns for a row. */
  notification: NotificationItemDto;
  /** The user's unread badge count after this write (omitted if unreadable). */
  unreadCount?: number;
  /** Admin policy allows an in-page toast for this type. */
  toast: boolean;
  /** A Web Push was accepted for this row — a tab may skip its own toast. */
  pushed: boolean;
  reason: NotificationDispatchReason;
}

/** `data` of a `sync` frame. */
export interface NotificationSyncFrame {
  type: 'sync';
}

/** `data` of a `ping` frame. */
export interface NotificationPingFrame {
  type: 'ping';
}

/** A message in the shape `@Sse()` serialises (`@nestjs/common` MessageEvent). */
export interface SseMessage {
  data: string | object;
  type?: string;
}

const PING: SseMessage = {
  type: NOTIFICATION_PING_SSE_EVENT,
  data: { type: 'ping' } satisfies NotificationPingFrame,
};

@Injectable()
export class NotificationStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationStreamService.name);

  /** user id → that user's open connections, in open order. Emptied buckets are deleted. */
  private readonly subscribers = new Map<string, Set<Subscriber<SseMessage>>>();

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Open a stream for ONE user — the authenticated principal, never an id
   * taken from a request parameter. Cold and per-caller: registration happens
   * on subscribe, teardown on every exit path (disconnect, complete, error).
   */
  subscribe(userId: string): Observable<SseMessage> {
    return new Observable<SseMessage>((observer) => {
      let bucket = this.subscribers.get(userId);
      if (!bucket) {
        bucket = new Set();
        this.subscribers.set(userId, bucket);
      }
      bucket.add(observer);

      // Enforce the cap by evicting the oldest (Set iterates in insert order).
      while (bucket.size > MAX_CONNECTIONS_PER_USER) {
        const oldest = bucket.values().next().value as Subscriber<SseMessage>;
        bucket.delete(oldest);
        oldest.complete();
      }

      // Commits the response headers immediately (the SSE writer defers them
      // until the first message) so the client's onopen fires and a buffering
      // proxy has bytes to flush.
      observer.next(PING);

      const heartbeat = setInterval(() => {
        observer.next(PING);
      }, HEARTBEAT_INTERVAL_MS);
      // An idle tab must never keep the process alive at shutdown.
      heartbeat.unref?.();

      return () => {
        clearInterval(heartbeat);
        const open = this.subscribers.get(userId);
        if (open) {
          open.delete(observer);
          if (open.size === 0) this.subscribers.delete(userId);
        }
      };
    });
  }

  /**
   * Write one frame to every connection this user has open. Never throws; a
   * no-op (returning 0) when the user has no tab open, which is the normal case.
   */
  publish(userId: string, message: SseMessage): number {
    const bucket = this.subscribers.get(userId);
    if (!bucket || bucket.size === 0) return 0;
    let delivered = 0;
    for (const observer of [...bucket]) {
      try {
        observer.next(message);
        delivered += 1;
      } catch (err) {
        this.logger.debug(
          `Dropping a stream write for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return delivered;
  }

  /** Tell every open tab of this user to refetch. Never throws. */
  publishSync(userId: string): number {
    const frame: NotificationSyncFrame = { type: 'sync' };
    return this.publish(userId, { type: NOTIFICATION_SYNC_SSE_EVENT, data: frame });
  }

  /** Open connections for one user, or across all users when omitted. */
  connectionCount(userId?: string): number {
    if (userId !== undefined) return this.subscribers.get(userId)?.size ?? 0;
    let total = 0;
    for (const bucket of this.subscribers.values()) total += bucket.size;
    return total;
  }

  /**
   * `notification.dispatched` → the user's open tabs.
   *
   * Cheap when nobody is listening: the connection check comes first, so the
   * unread-count read (cached ~2 s per user) only happens for a user who has
   * a tab open. Never throws into the emitter.
   */
  @OnEvent(NOTIFICATION_DISPATCHED_EVENT)
  async onDispatched(event: NotificationDispatchedEvent): Promise<void> {
    try {
      if (this.connectionCount(event.userId) === 0) return;

      let unreadCount: number | undefined;
      try {
        unreadCount = (await this.notifications.getUnreadCount(event.userId)).count;
      } catch {
        unreadCount = undefined; // the client refetches; a missing count is harmless
      }

      const frame: NotificationStreamFrame = {
        type: 'notification',
        notification: event.notification,
        ...(unreadCount !== undefined ? { unreadCount } : {}),
        toast: event.toast,
        pushed: event.pushed,
        reason: event.reason,
      };
      this.publish(event.userId, { type: NOTIFICATION_SSE_EVENT, data: frame });
    } catch (err) {
      this.logger.debug(
        `stream publish for user ${event.userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Close every stream on shutdown so clients reconnect to the new instance
   * immediately instead of hanging on a socket nobody will write to again.
   */
  onModuleDestroy(): void {
    for (const bucket of [...this.subscribers.values()]) {
      for (const observer of [...bucket]) observer.complete();
    }
    this.subscribers.clear();
  }
}
