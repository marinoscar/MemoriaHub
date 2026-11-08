// =============================================================================
// Platform conformance (RETRO-B1, #597)
// =============================================================================
//
// The platform's invariants, run against MemoriaHub's own module graph. Each
// adopted slice adds its suite here (RETRO-B1b doctor, RETRO-B2 identity, ...);
// a slice not adopted yet has no entry rather than a skip, because there is
// nothing to opt out of.
//
// `host` (`@marinoscar/platform-api/host/testing`): a walk of `AppModule` from
// its root. `MaintenanceGuard` is the first and only global guard,
// `PlatformHostCoreModule.forRoot()` is imported exactly once, and the
// `{ data }` envelope and the exception filter are global exactly once each.
// =============================================================================

import { join } from 'node:path';

import '@marinoscar/platform-api/host/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { AppModule } from '../src/app.module';

runPlatformConformance({
  sourceRoots: [join(__dirname, '..', 'src')],
  suites: {
    // MaintenanceGuard is the application's only global guard: MemoriaHub has no
    // global JWT guard (every route declares its own @Auth()/@Public()) and no
    // global throttler. If one is ever added, list it here with a reason.
    host: { rootModule: AppModule },
  },
});
