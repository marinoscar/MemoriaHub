// =============================================================================
// The platform Doctor (RETRO-B1b, #602)
// =============================================================================
//
// `GET /api/admin/doctor` (`system_settings:read`) runs every registered
// read-only check and reports pass / warn / fail / skip with a remedy;
// `GET /api/admin/doctor/support-bundle` downloads a redacted diagnostic archive
// named after `APP_SLUG`. Replaces `POST /api/admin/doctor/run` and the old
// 1 900-line `DoctorService`.
//
// This app's checks are in `./checks/` and provided by `DoctorChecksModule`
// (`./doctor-checks.module.ts`). The platform's own (`db.connection`,
// `db.migrations`, `secrets.encryption-key`, `db.rls_role`, `maintenance.mode`,
// ...) come with `PlatformHostCoreModule`.
//
// `categoryOrder` keeps the old report's section order and slots the host
// core's categories where they belong: the app's `face` and `geo` follow `ai`,
// and `workflows` and `android` close the report.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import { DoctorModule } from '@marinoscar/platform-api/doctor';

import { platformHost } from '../platform/platform-host';

/** The report's category order (also the packaged page's `categories` order). */
export const DOCTOR_CATEGORY_ORDER = [
  'core',
  'auth',
  'maintenance',
  'storage',
  'email',
  'push',
  'ai',
  'face',
  'geo',
  'jobs',
  'nodes',
  'workflows',
  'android',
  'backup',
  'telemetry',
  'network',
] as const;

export const doctorModule = DoctorModule.forRoot({
  host: platformHost,
  categoryOrder: DOCTOR_CATEGORY_ORDER,
  supportBundle: { appSlug: APP_SLUG },
});
