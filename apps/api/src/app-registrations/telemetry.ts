// =============================================================================
// MemoriaHub's telemetry dashboard groups (RETRO-T2, #625)
// =============================================================================
//
// The metric groups this app adds to the Telemetry Dashboard, after the
// platform's own (`host`, `database`, `queue`, `nodes`, `uptime`, `pipeline`).
// Passed to `TelemetryModule.forRoot({ metricGroups })` by
// `platform/telemetry/telemetry.config.ts`, which registers them before the
// controllers are built.
//
// RETRO-T3 (#628) adds MemoriaHub's six groups (`media`, `enrichment`,
// `memories`, `storage`, `ai_spend`, `fleet_mh`; platform-extensions/telemetry/
// memoriahub.metric-groups.ts), the `usd` / `items_per_min` units, the
// "Bulk import progress" dashboard panel and, in telemetry.config.ts, the
// verdict policy. A group id and its family keys are permanent once dashboards
// and saved queries name them.
// =============================================================================

import { registerDashboardPanel, dashboardPanelRegistry, type MetricGroupDef } from '@marinoscar/platform-api/telemetry';

import { IMPORT_PROGRESS_DASHBOARD_PANEL } from '../platform-extensions/telemetry/import-progress.dashboard-panel';
import { MEMORIAHUB_METRIC_GROUPS } from '../platform-extensions/telemetry/memoriahub.metric-groups';

export const APP_METRIC_GROUPS: readonly MetricGroupDef[] = [...MEMORIAHUB_METRIC_GROUPS];

// The "Bulk import progress" card (`memoriahub.import_progress`), registered at
// import time, before the registry freezes; the web view is registered under the
// same id (apps/web/src/platform-extensions/telemetry/).
if (!dashboardPanelRegistry.has(IMPORT_PROGRESS_DASHBOARD_PANEL.id)) {
  registerDashboardPanel(IMPORT_PROGRESS_DASHBOARD_PANEL);
}
