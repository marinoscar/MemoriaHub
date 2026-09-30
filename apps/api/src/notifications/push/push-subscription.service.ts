import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PushConfigService } from './push-config.service';
import type { PushSubscribeRequest, PushSubscriptionResponse } from './dto/push-subscription.dto';

// =============================================================================
// PushSubscriptionService (epic #481, issue #483)
// =============================================================================
//
// The user-facing write/delete half of `push_subscriptions`. The sender
// (PushNotificationChannel, #484) reads and prunes the same rows on behalf of
// the dispatcher, never on behalf of a user's own request — which is why those
// writes do not live here.
// =============================================================================

@Injectable()
export class PushSubscriptionService {
  private readonly logger = new Logger(PushSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
  ) {}

  /**
   * Upsert a browser subscription BY ENDPOINT (unique on its own).
   *
   * Re-subscribing the same endpoint under a different signed-in user MOVES
   * the row to that user: a shared machine must not keep receiving the
   * previous owner's pushes. On update `failureCount` resets to 0 — a browser
   * actively re-registering is evidence the endpoint is alive.
   *
   * 409 when no VAPID key pair is active: the body is valid, it is the
   * deployment's state that makes the operation impossible right now.
   */
  async subscribe(
    userId: string,
    dto: PushSubscribeRequest,
    userAgent: string | undefined,
  ): Promise<PushSubscriptionResponse> {
    if (!(await this.pushConfig.resolveActiveVapidConfig())) {
      throw new ConflictException('Web Push is not enabled on this deployment');
    }

    const expirationTime = dto.expirationTime == null ? null : new Date(dto.expirationTime);
    const ua = userAgent ? userAgent.slice(0, 512) : null;

    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      update: {
        userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        expirationTime,
        userAgent: ua,
        failureCount: 0,
      },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        expirationTime,
        userAgent: ua,
      },
    });

    this.logger.log(`Upserted push subscription ${row.id} for user ${userId}`);
    return { id: row.id, endpoint: row.endpoint, createdAt: row.createdAt.toISOString() };
  }

  /**
   * Remove one of the caller's OWN subscriptions. A single ownership-scoped
   * `deleteMany` — `endpoint` alone is unique, so a bare `delete` keyed on it
   * could remove another user's row. "Not found" and "someone else's" are
   * deliberately indistinguishable (404).
   */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    const { count } = await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    if (count === 0) {
      throw new NotFoundException('Push subscription not found');
    }
  }

  /** Does this user have at least one registered push subscription? */
  async hasActivePushSubscription(userId: string): Promise<boolean> {
    const count = await this.prisma.pushSubscription.count({ where: { userId } });
    return count > 0;
  }
}
