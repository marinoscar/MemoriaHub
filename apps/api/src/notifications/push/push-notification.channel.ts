import { Injectable, Logger } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';

import { PrismaService } from '../../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { ActiveVapidConfig, PushConfigService } from './push-config.service';

// =============================================================================
// PushNotificationChannel (epic #481, issue #484)
// =============================================================================
//
// Hands an encrypted payload for an ALREADY-WRITTEN `notifications` row to
// every push subscription its owner has registered. Unlike the EAB reference,
// this channel writes NO notification row of its own: in MemoriaHub the inbox
// row is written first by NotificationsService, and the push payload simply
// references its id — one logical notification, one row, shared id (the
// payload's `tag` is that id, so a browser replaces rather than stacks a
// re-pushed counted row).
//
// ENDPOINT BOOKKEEPING
//   success  → failureCount = 0, lastSuccessAt = now
//   404/410  → the endpoint is gone for good: row deleted immediately
//   anything else (429/5xx/timeout/DNS) → failureCount++, deleted at
//              MAX_PUSH_FAILURE_COUNT — tolerant of a push service's bad
//              minute, but a dead endpoint cannot accumulate forever.
//
// NEVER THROWS: every path returns a PushDeliveryResult. One dead endpoint
// among several never stops the others (`Promise.allSettled`).
//
// VAPID details are passed PER CALL (`options.vapidDetails`), never via
// `webpush.setVapidDetails` — global state would race a concurrent rotation.
// =============================================================================

export const MAX_PUSH_FAILURE_COUNT = 5;
/** How long a push service may hold a message for an offline device. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1_000;
const FALLBACK_LINK = '/notifications';
const FORBIDDEN_LINK_CHARS = /[\u0000-\u001F\u007F\\]/;

export interface PushPayload {
  id: string;
  title: string;
  body: string;
  link: string;
  tag: string;
  type: string;
  circleId: string | null;
  icon: string;
  badge: string;
}

export interface PushDeliveryResult {
  /** At least one endpoint accepted the push. */
  success: boolean;
  attempted: number;
  sent: number;
  failed: number;
  pruned: number;
  /** Counts-only summary when nothing was delivered. Never a body or a key. */
  error: string | null;
}

/**
 * Root-relative in-app links only. Anything else — absolute URLs,
 * protocol-relative `//host`, `/\host`, control characters, relative paths —
 * falls back to the inbox page rather than dropping the notification.
 */
export function sanitizePushLink(link: string | null | undefined): string {
  if (!link) return FALLBACK_LINK;
  const trimmed = link.trim();
  if (FORBIDDEN_LINK_CHARS.test(trimmed)) return FALLBACK_LINK;
  if (!trimmed.startsWith('/')) return FALLBACK_LINK;
  if (trimmed.startsWith('//')) return FALLBACK_LINK;
  return trimmed;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function buildPushPayload(
  notification: Pick<Notification, 'id' | 'type' | 'title' | 'body' | 'link' | 'circleId'>,
): PushPayload {
  return {
    id: notification.id,
    title: truncate(notification.title, MAX_TITLE_LENGTH),
    body: truncate(notification.body ?? '', MAX_BODY_LENGTH),
    link: sanitizePushLink(notification.link),
    tag: notification.id,
    type: notification.type,
    circleId: notification.circleId ?? null,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
  };
}

@Injectable()
export class PushNotificationChannel {
  private readonly logger = new Logger(PushNotificationChannel.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
  ) {}

  async deliver(
    notification: Pick<Notification, 'id' | 'userId' | 'type' | 'title' | 'body' | 'link' | 'circleId'>,
    vapid?: ActiveVapidConfig | null,
  ): Promise<PushDeliveryResult> {
    try {
      return await this.deliverInner(notification, vapid);
    } catch (err) {
      return {
        success: false,
        attempted: 0,
        sent: 0,
        failed: 0,
        pruned: 0,
        error: `Push delivery failed unexpectedly: ${describeThrown(err)}`,
      };
    }
  }

  private async deliverInner(
    notification: Pick<Notification, 'id' | 'userId' | 'type' | 'title' | 'body' | 'link' | 'circleId'>,
    vapidArg?: ActiveVapidConfig | null,
  ): Promise<PushDeliveryResult> {
    const empty = { attempted: 0, sent: 0, failed: 0, pruned: 0 };

    const active = vapidArg === undefined ? await this.pushConfig.resolveActiveVapidConfig() : vapidArg;
    if (!active) {
      return { success: false, ...empty, error: 'Web Push is not configured or is disabled' };
    }

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: notification.userId },
    });
    if (subscriptions.length === 0) {
      return { success: false, ...empty, error: 'No push subscriptions for this user' };
    }

    const payload = JSON.stringify(buildPushPayload(notification));
    const options = {
      vapidDetails: {
        subject: active.subject,
        publicKey: active.publicKey,
        privateKey: active.privateKey,
      },
      TTL: PUSH_TTL_SECONDS,
      timeout: SEND_TIMEOUT_MS,
    };

    const results = await Promise.allSettled(
      subscriptions.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          options,
        ),
      ),
    );

    let sent = 0;
    let failed = 0;
    let pruned = 0;

    await Promise.all(
      results.map(async (result, i) => {
        const sub = subscriptions[i];

        if (result.status === 'fulfilled') {
          sent++;
          await this.prisma.pushSubscription
            .update({ where: { id: sub.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } })
            .catch((err) =>
              this.logger.warn(`Could not record push success for ${sub.id}: ${describeThrown(err)}`),
            );
          return;
        }

        const err = result.reason;
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          pruned++;
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch((e) =>
              this.logger.warn(`Could not prune dead push subscription ${sub.id}: ${describeThrown(e)}`),
            );
          return;
        }

        failed++;
        const updated = await this.prisma.pushSubscription
          .update({
            where: { id: sub.id },
            data: { failureCount: { increment: 1 } },
            select: { failureCount: true },
          })
          .catch((e) => {
            this.logger.warn(`Could not record push failure for ${sub.id}: ${describeThrown(e)}`);
            return null;
          });

        if (updated && updated.failureCount >= MAX_PUSH_FAILURE_COUNT) {
          pruned++;
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch((e) =>
              this.logger.warn(`Could not prune exhausted push subscription ${sub.id}: ${describeThrown(e)}`),
            );
        }
      }),
    );

    this.logger.debug(
      `Push ${notification.type} ${notification.id} for user ${notification.userId}: ` +
        `${sent} sent, ${failed} failed, ${pruned} pruned (of ${subscriptions.length})`,
    );

    const counts = { attempted: subscriptions.length, sent, failed, pruned };
    return sent > 0
      ? { success: true, ...counts, error: null }
      : {
          success: false,
          ...counts,
          error: `Push failed for all ${subscriptions.length} subscription(s) (${pruned} pruned)`,
        };
  }
}
