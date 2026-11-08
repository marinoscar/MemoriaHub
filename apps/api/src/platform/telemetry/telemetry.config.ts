// =============================================================================
// The telemetry slice's composition (RETRO-T2, #625)
// =============================================================================
//
// `TelemetryModule.forRoot` serves the API side of observability: the `telemetry`
// settings and the runtime export gate (`/api/admin/telemetry/config`,
// `GET /api/telemetry/config`), the runtime GreptimeDB connection
// (`/api/admin/telemetry/connection`), the explorer (SQL, schema, export), the
// dashboard with its metric groups and health verdict, the stack-agent surface,
// the assistant (off until RETRO-E4: `telemetry-ai.adapter.ts`), two server-only
// job types (`telemetry.retention.apply`, `telemetry.stack.deploy`) with the
// retention cron, and five Doctor checks (`telemetry.*`). The SDK itself is
// RETRO-T1's `instrumentation.ts`; its export gate starts CLOSED and this slice's
// `TelemetrySettingsService` opens it when `telemetry.enabled` is on AND a store
// is configured, on boot and on every refresh (no restart).
//
// Permissions: `telemetry:read|write|query` (admin, registered by the platform
// permission manifest, `app-registrations/permissions.ts`). The assistant also
// needs `ai:use`.
//
// The `telemetry` namespace (`telemetry.system-settings.ts`) is registered by
// `app-registrations/settings.ts`, and the `telemetry_greptime` credential purpose
// by `platform/credentials/credential-purposes.manifest.ts`, both before the
// registries freeze at bootstrap. The deployment defaults are the `greptime`,
// `stackAgent` and `otel` configuration blocks (`config/configuration.ts`); the
// connection saved at /admin/settings/telemetry overrides `greptime`.
//
// Needs `jobsModule` and `settingsModule` (both global) in the same application.
// Mounted ONCE, by `app.module.ts`.
// =============================================================================

import { TelemetryModule } from '@marinoscar/platform-api/telemetry';

import { APP_METRIC_GROUPS } from '../../app-registrations/telemetry';
import { platformHost } from '../platform-host';
import { MEMORIAHUB_VERDICT_THRESHOLDS } from './memoriahub-verdict-thresholds';
import { TelemetryHostModule } from './telemetry-host.module';

export const telemetryModule = TelemetryModule.forRoot({
  host: platformHost,
  imports: [TelemetryHostModule],
  metricGroups: [...APP_METRIC_GROUPS],
  dashboard: { verdictThresholds: MEMORIAHUB_VERDICT_THRESHOLDS },
});
