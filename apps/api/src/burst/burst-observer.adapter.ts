import { Injectable, Optional } from '@nestjs/common';
import type { BurstObserver } from '@marinoscar/memoriahub-api/burst';

import { MemoriaHubWebhooks } from '../platform/webhooks/memoriahub-webhooks.service';

/**
 * The web app's {@link BurstObserver} (RETRO-J10, #624): a burst resolve that trashed members reaches the
 * `media.item.trashed` webhook event (RETRO-H4, #603), batched and never throwing.
 */
@Injectable()
export class AppBurstObserver implements BurstObserver {
  constructor(
    // Optional so a hand-built test module needs no webhook stub.
    @Optional() private readonly webhookEvents?: MemoriaHubWebhooks,
  ) {}

  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void {
    this.webhookEvents?.mediaTrashed(circleId, mediaItemIds);
  }
}
