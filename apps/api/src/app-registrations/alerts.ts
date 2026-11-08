// =============================================================================
// The alerts slice's registrations (RETRO-H5, #609)
// =============================================================================
//
// Imported by `platform/alerts/alerts.config.ts` before `AlertsModule.forRoot`
// composes, so every registry is filled before the application bootstraps (the
// registries freeze then):
//
//   * the slice's two app metrics (`app.alerts.transitions`, `app.alerts.firing`;
//     neither carries a rule name, a label value, an org id or a user id);
//   * the platform's five built-in kinds (idempotent) and MemoriaHub's two rule kinds (`memoriahub_queue_stalled`,
//     `memoriahub_db_backup_stale`; ids permanent).
//
// The two notification events and their email templates are registered by the
// notification manifest (`platform/notifications/notification.manifest.ts`),
// and `alerts:read` / `alerts:write` by the platform permission manifest
// (`permissions.ts`, slice `alerts`).
// =============================================================================

import { ALERTS_APP_METRICS, registerBuiltinAlertKinds } from '@marinoscar/platform-api/alerts';
import { appMetricRegistry, registerAppMetrics } from '@marinoscar/platform-api/otel-core';

import { registerMemoriaHubAlertKinds } from '../platform/alerts/memoriahub-alert-kinds';

if (!appMetricRegistry.has(ALERTS_APP_METRICS[0].key)) {
  registerAppMetrics(ALERTS_APP_METRICS);
}

// The five built-in kinds (idempotent; `forRoot` registers them too): the seed
// validates the starter configs against them.
registerBuiltinAlertKinds();
registerMemoriaHubAlertKinds();
