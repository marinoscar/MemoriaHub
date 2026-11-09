// =============================================================================
// The telemetry slice's conformance suite, run in MemoriaHub (RETRO-T2, #625)
// =============================================================================
//
// The invariants of `@marinoscar/platform-api/telemetry` (its README, "Conformance
// suite"), checked against THIS application: every registered metric group (the
// platform's six plus `APP_METRIC_GROUPS`, empty until RETRO-T3) is well formed and
// degrades to `skipped` on an empty schema; every telemetry route declares exactly
// its permissions; no Doctor check of the slice can write, enqueue or audit; no
// response carries a stored password; the dashboard panels and assistant tools
// are well formed; and the module boots with no GreptimeDB.
//
// Kept out of `test/conformance.spec.ts` on purpose: the suite boots its own stub
// application, so it needs none of the app-wide fixtures and stays cheap.
//
// CHECK 5 (CRON COVERAGE) IS NOT RUN, so it reports "skipped, no cronSourceRoots
// given". The check looks for `tasks/telemetry-retention.task.ts` under the app's
// `cron-enqueue-only` scan roots; the published package ships compiled `dist/`
// only (`telemetry-retention.task.js` and `.d.ts`), so no root an app can pass
// contains the TypeScript source the scan reads. MemoriaHub's own
// `cron-enqueue-only` run is opted out until RETRO-C9 as well. Seam gap reported
// on the issue; see docs/platform-adoption/local-exceptions.md.
//
// Check 7 (web/API permission parity) is the web test
// `apps/web/src/__tests__/config/telemetryParity.test.ts`; check 8 (infra drift) is
// `npm run platform:infra:sync -- --check`.
// =============================================================================

import { join } from 'node:path';

import { metricGroupRegistry } from '@marinoscar/platform-api/telemetry';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';
// Importing the testing entry REGISTERS the `telemetry` suite with the harness.
import '@marinoscar/platform-api/telemetry/testing';

// Importing the app's binding runs `TelemetryModule.forRoot`, which registers the
// app's own metric groups in the registry the suite discovers them from.
import '../../src/platform/telemetry/telemetry.config';
import { APP_METRIC_GROUPS } from '../../src/app-registrations/telemetry';

runPlatformConformance({
  sourceRoots: [join(__dirname, '..', '..', 'src')],
  suites: { telemetry: {} },
});

describe('the telemetry suite sees this application', () => {
  it("discovers the platform's six groups and then this app's six (RETRO-T3)", () => {
    expect(metricGroupRegistry.ids()).toEqual([
      'host',
      'database',
      'queue',
      'nodes',
      'uptime',
      'pipeline',
      ...APP_METRIC_GROUPS.map((group) => group.id),
    ]);
  });
});
