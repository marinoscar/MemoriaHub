import { Injectable, Optional } from '@nestjs/common';
import type { DuplicateObserver } from '@marinoscar/memoriahub-api/dedup';

import { MemoriaHubWebhooks } from '../platform/webhooks/memoriahub-webhooks.service';

/**
 * The web app's {@link DuplicateObserver} (RETRO-J10, #624): a duplicate resolve that trashed members reaches
 * the `media.item.trashed` webhook event (RETRO-H4, #603), batched and never throwing.
 */
@Injectable()
export class AppDuplicateObserver implements DuplicateObserver {
  constructor(
    // Optional so a hand-built test module needs no webhook stub.
    @Optional() private readonly webhookEvents?: MemoriaHubWebhooks,
  ) {}

  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void {
    this.webhookEvents?.mediaTrashed(circleId, mediaItemIds);
  }
}
