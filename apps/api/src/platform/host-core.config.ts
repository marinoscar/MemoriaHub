// =============================================================================
// The platform host core (RETRO-B1, #597)
// =============================================================================
//
// `PlatformHostCoreModule.forRoot` is GLOBAL and replaces what this app ran by
// hand:
//
//   * the event bus (`EVENT_BUS`) and `AppMetricsService` (which took over the
//     OtelMetricsModule T1 mounted in `app.module.ts`);
//   * maintenance mode: `MaintenanceModeService`, `GET|PUT /api/admin/maintenance`
//     and `MaintenanceGuard`, the application's ONLY `APP_GUARD`;
//   * `GET /api/health`, `/api/health/live` and `/api/health/ready`;
//   * the `{ data, meta }` envelope (`TransformInterceptor`), the request log
//     line (`LoggingInterceptor`), `HttpExceptionFilter` and request ids.
//
// `../app-registrations/host` is imported FIRST so the About contributors and
// the maintenance bypasses are registered before the application is created
// (the registries freeze when it bootstraps).
//
// ERROR MAPPERS: none. The old filter, like the platform one, answers a thrown
// non-HTTP error with that error's own message (and, outside production, its
// stack in `details`), so no client lost a Prisma error text.
// =============================================================================

import '../app-registrations/host';

import { PlatformHostCoreModule } from '@marinoscar/platform-api/host';

import { platformHost } from './platform-host';

export const hostCoreModule = PlatformHostCoreModule.forRoot({ host: platformHost });
