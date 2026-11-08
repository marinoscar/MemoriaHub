// =============================================================================
// The alerts slice, as MemoriaHub binds it (RETRO-H5, #609)
// =============================================================================
//
// `AlertsModule.forRoot` evaluates alert rules over telemetry metrics,
// worker-node events and fleet health, keeps incidents (pending, firing,
// resolved; one open incident per rule and label set, the raw-SQL index
// `alert_incidents_open_uniq_idx` of platform migration `0040_add_alerts`),
// notifies the holders of `alerts:read` and serves `/api/admin/alerts`
// (`alerts:read` / `alerts:write`, admin only). Evaluation is a queue job:
// `AlertsEvaluateTask` only enqueues `alerts.evaluate` every minute and
// `AlertsPurgeTask` `alerts.incidents_purge` daily (all three job types
// server-only); the node-event listener only enqueues `alerts.evaluate_event`.
//
// Imports: the jobs module (`JobsService`, the handler registry) and the
// telemetry module (the `metric_threshold` and `verdict` kinds read the
// GreptimeDB store through it; with telemetry off they report the store
// unavailable in the rule's `lastError` and leave their incidents as they are).
//
// WEBHOOK PORT (RETRO-H4, #603): `ALERTS_WEBHOOK_EMITTER` is bound to the
// webhooks slice's `WebhooksService.emit` through `AlertsWebhooksHostModule`
// (`alerts-webhooks.adapter.ts`, kvox precedent), which also registers the
// `alerts.alert.fired` and `alerts.alert.resolved` events (system audience) in
// the webhooks catalog. A rule's `webhook` flag now sends its transitions to the
// deployment's endpoints that subscribe to them.
//
// `MemoriaHubAlertRulesModule` seeds MemoriaHub's defaults
// (`memoriahub-alert-rules.seed.ts`). The registrations (metrics, the two app
// kinds) are `app-registrations/alerts.ts`. Mounted ONCE, by `app.module.ts`.
// =============================================================================

import '../../app-registrations/alerts';

import { Module } from '@nestjs/common';
import { ALERTS_WEBHOOK_EMITTER, AlertsModule } from '@marinoscar/platform-api/alerts';

import { jobsModule } from '../jobs/jobs.config';
import { telemetryModule } from '../telemetry/telemetry.config';
import { webhooksModule } from '../webhooks/webhooks.config';
import { AlertsWebhookAdapter, registerAlertWebhookEvents } from './alerts-webhooks.adapter';
import { MemoriaHubAlertRulesModule } from './memoriahub-alert-rules.seed';

registerAlertWebhookEvents();

/** Binds the alerts slice's webhook port to `WebhooksService.emit`. */
@Module({
  imports: [webhooksModule],
  providers: [AlertsWebhookAdapter, { provide: ALERTS_WEBHOOK_EMITTER, useExisting: AlertsWebhookAdapter }],
  exports: [ALERTS_WEBHOOK_EMITTER],
})
export class AlertsWebhooksHostModule {}

export const alertsModule = AlertsModule.forRoot({ imports: [jobsModule, telemetryModule, AlertsWebhooksHostModule] });

/** The slice and MemoriaHub's rule seed, spread into `AppModule.imports`. */
export const alertsModules = [alertsModule, MemoriaHubAlertRulesModule] as const;
