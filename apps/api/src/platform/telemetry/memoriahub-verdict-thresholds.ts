// =============================================================================
// MemoriaHub's dashboard verdict thresholds (RETRO-T2, #625)
// =============================================================================
//
// `TelemetryModule.forRoot({ dashboard: { verdictThresholds } })` deep-merges
// this object over the platform's `DEFAULT_VERDICT_THRESHOLDS` and validates the
// result at boot (a bad value, or a degraded bound beyond its critical one,
// fails startup naming the field).
//
// BEHAVIOUR-NEUTRAL TODAY: every value equals the platform default (the spec
// `test/telemetry/memoriahub-verdict-thresholds.spec.ts` pins that), spelled out
// so the knobs are visible in place. RETRO-T3 (MemoriaHub metric groups and
// verdict policy) tunes them, e.g. a longer `oldestPendingJobMinutes` for a bulk
// import's backlog. Delete a line to fall back to the default.
// =============================================================================

import type { VerdictThresholdsOverride } from '@marinoscar/platform-api/telemetry';

export const MEMORIAHUB_VERDICT_THRESHOLDS: VerdictThresholdsOverride = {
  minRequests: 20,
  errorRatePct: { degraded: 2, critical: 5 },
  p95Ms: { degraded: 1000, critical: 3000 },
  errorLogs: { minCurrent: 10, degradedRatio: 3, criticalRatio: 10 },
  noDataMinutes: 5,
  unknownRoutes: { criticalBearerRequests: 20, criticalDistinctRoutes: 3 },
  diskUtilizationPct: { degraded: 85, critical: 95 },
  memoryUtilizationPct: { degraded: 90, critical: 97 },
  dbConnectionsPct: { degraded: 80, critical: 95 },
  oldestPendingJobMinutes: { degraded: 10, critical: 30 },
  tlsDaysLeft: { degraded: 14, critical: 7 },
  uptimeMinChecksForCritical: 2,
  collectorFailedPct: { critical: 10 },
  backupAgeHours: { degraded: 26, critical: 50 },
};
