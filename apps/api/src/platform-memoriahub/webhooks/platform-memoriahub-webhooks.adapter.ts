import { Injectable } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';
import type { MemoriahubWebhookContext, MemoriahubWebhooksPort } from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubWebhooksAdapter: the `MEMORIAHUB_WEBHOOKS` port over `WebhooksService.emit`
// (RETRO-J4, #610)
// =============================================================================
//
// The platform slice records the delivery rows and enqueues the `webhooks.fanout` job; the HTTP call to a
// subscriber is a queue job, never inline. MemoriaHub's events are declared in
// `platform/webhooks/memoriahub-webhook-events.ts`. MemoriaHub is single-organization (`TENANCY_MODE=single`),
// so an event with no organization is the default organization's: the platform resolves it when `orgId` is null.
// =============================================================================

@Injectable()
export class PlatformMemoriahubWebhooksAdapter implements MemoriahubWebhooksPort {
  constructor(private readonly webhooks: WebhooksService) {}

  @Trace()
  async emit(eventKey: string, data: unknown, ctx: MemoriahubWebhookContext): Promise<void> {
    await this.webhooks.emit(eventKey, data, {
      orgId: ctx.orgId,
      ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    });
  }
}
