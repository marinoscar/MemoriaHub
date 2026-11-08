// =============================================================================
// The webhooks slice's composition (RETRO-H4, #603)
// =============================================================================
//
// `@marinoscar/platform-api/webhooks`, configured for MemoriaHub: the product
// name in the `User-Agent` and the host module that binds the bypass client.
// Every other option is the slice's default (20 consecutive failures open the
// circuit, 24 hours of secret overlap on a rotation, 30 days of delivery
// history, https only, no private targets). A deployment that must call an
// internal receiver sets `allowedHosts` here, never an environment variable.
//
// It serves `/api/webhooks` (a member's own endpoints, `webhooks:*`),
// `/api/org/webhooks` (`org_webhooks:*`, unused in single-organization mode)
// and `/api/admin/webhooks` (`system_webhooks:*`), runs the job types
// `webhooks.deliver`, `webhooks.fanout` and `webhooks.deliveries_purge`
// (server-only; type strings permanent) and registers the `webhook`
// notification channel's sender.
//
// MemoriaHub's events are registered first (`memoriahub-webhook-events.ts`);
// `MemoriaHubWebhooksModule` (global) exposes `MemoriaHubWebhooks`, the one
// service the app's write paths raise them through.
// =============================================================================

import './memoriahub-webhook-events';

import { Global, Module } from '@nestjs/common';
import { WebhooksModule } from '@marinoscar/platform-api/webhooks';
import { PRODUCT_NAME } from '@app/shared';

import { WebhooksHostModule } from './webhooks-host.module';
import { MemoriaHubWebhooks } from './memoriahub-webhooks.service';

export const webhooksModule = WebhooksModule.forRoot({
  appName: PRODUCT_NAME,
  imports: [WebhooksHostModule],
});

/** Global so `MediaService`, the memory and workflow handlers inject `MemoriaHubWebhooks` without an import edge. */
@Global()
@Module({
  imports: [webhooksModule],
  providers: [MemoriaHubWebhooks],
  exports: [MemoriaHubWebhooks],
})
export class MemoriaHubWebhooksModule {}
