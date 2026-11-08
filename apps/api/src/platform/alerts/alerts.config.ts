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
// NO WEBHOOK PORT YET: `ALERTS_WEBHOOK_EMITTER` is optional and stays unbound
// until the webhooks slice is mounted (RETRO-H4), which adds an
// `AlertsWebhooksHostModule` to `imports` (kvox precedent). Until then a rule's
// `webhook` flag has no effect.
//
// `MemoriaHubAlertRulesModule` seeds MemoriaHub's defaults
// (`memoriahub-alert-rules.seed.ts`). The registrations (metrics, the two app
// kinds) are `app-registrations/alerts.ts`. Mounted ONCE, by `app.module.ts`.
// =============================================================================

import '../../app-registrations/alerts';

import { AlertsModule } from '@marinoscar/platform-api/alerts';

import { jobsModule } from '../jobs/jobs.config';
import { telemetryModule } from '../telemetry/telemetry.config';
import { MemoriaHubAlertRulesModule } from './memoriahub-alert-rules.seed';

export const alertsModule = AlertsModule.forRoot({ imports: [jobsModule, telemetryModule] });

/** The slice and MemoriaHub's rule seed, spread into `AppModule.imports`. */
export const alertsModules = [alertsModule, MemoriaHubAlertRulesModule] as const;
