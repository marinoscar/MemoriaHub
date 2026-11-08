// =============================================================================
// Platform conformance (RETRO-B1, #597)
// =============================================================================
//
// The platform's invariants, run against MemoriaHub's own module graph. Each
// adopted slice adds its suite here (RETRO-B1b doctor, RETRO-B2 identity, ...);
// a slice not adopted yet has no entry rather than a skip, because there is
// nothing to opt out of.
//
// `doctor-read-only` (`@marinoscar/platform-api/doctor/testing`): every Doctor
// check writes no row, job or object and holds no side-effecting test service.
//
// `host` (`@marinoscar/platform-api/host/testing`): a walk of `AppModule` from
// its root. `MaintenanceGuard` is the first and only global guard,
// `PlatformHostCoreModule.forRoot()` is imported exactly once, and the
// `{ data }` envelope and the exception filter are global exactly once each.
// =============================================================================

import { join } from 'node:path';

import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/host/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { DOCTOR_FORBIDDEN_SERVICES } from '@marinoscar/platform-api/doctor/testing';

import { AppModule } from '../src/app.module';
import { doctorConformanceFixture } from './conformance/doctor-fixture';

runPlatformConformance({
  sourceRoots: [join(__dirname, '..', 'src')],
  suites: {
    // MaintenanceGuard is the application's only global guard: MemoriaHub has no
    // global JWT guard (every route declares its own @Auth()/@Public()) and no
    // global throttler. If one is ever added, list it here with a reason.
    host: { rootModule: AppModule },

    // Rule 3 of the Doctor check contract (RETRO-B1b, #602): every registered
    // check is read-only. Suite id: `doctor-read-only`. The checks are DISCOVERED
    // from the booted app's registry; the floor is a vacuity guard, not a list.
    // `StorageSettingsService` is MemoriaHub's own side-effecting "test
    // connection" service (it writes a sentinel object), so a check holding it
    // is a regression. The AI, face and geo settings services stay allowed: see
    // the live-probe row of docs/platform-adoption/local-exceptions.md.
    doctorReadOnly: {
      fixture: doctorConformanceFixture,
      minChecks: 30,
      forbiddenServices: [...DOCTOR_FORBIDDEN_SERVICES, 'StorageSettingsService'],
    },
  },
});
