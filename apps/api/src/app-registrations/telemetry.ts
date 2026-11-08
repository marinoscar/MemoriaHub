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
// EMPTY UNTIL RETRO-T3, which adds MemoriaHub's groups (enrichment, uploads,
// media) and their verdict policy. A group id and its family keys are permanent
// once dashboards and saved queries name them.
// =============================================================================

import type { MetricGroupDef } from '@marinoscar/platform-api/telemetry';

export const APP_METRIC_GROUPS: readonly MetricGroupDef[] = [];
