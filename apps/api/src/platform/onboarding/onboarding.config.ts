import { OnboardingModule } from '@marinoscar/platform-api/onboarding';

// The steps and facts register at import time; the stored `onboarding` namespace's merge reads the
// step registry, so the manifest must run before any request.
import './onboarding.manifest';
import { OnboardingHostModule } from './onboarding-host.module';

// =============================================================================
// The onboarding slice's composition (RETRO-H3, #599, epic #584)
// =============================================================================
//
// `OnboardingModule.forRoot` serves:
//
//   GET /api/onboarding                 the caller's stored UI state, the `user` checklist (Get
//                                       started) and, for a holder of `system_settings:read`, the
//                                       `admin` checklist (Setup guide); `user_settings:read`
//   GET /api/admin/onboarding/metrics   aggregate activation metrics (`system_settings:read`)
//
// Completion is DERIVED on every read and never stored. Only the caller's intent (welcome seen,
// checklists dismissed, steps skipped) is stored, in the platform's `onboarding` user-settings
// namespace (registered by `settings/registry/user-settings.manifest.ts`) through
// `PATCH /api/user-settings`. No table, no migration.
//
// The admin gate is the platform default, `system_settings:read`, also the Doctor's permission
// (the source of `memoriahub.enable_faces`); `INITIAL_ADMIN_EMAIL` is what `admin.access` excludes.
// Steps and facts: `onboarding.manifest.ts`. Mounted ONCE, by `app.module.ts`.
// =============================================================================

export const onboardingModule = OnboardingModule.forRoot({
  adminPermission: 'system_settings:read',
  initialAdminEmailEnv: 'INITIAL_ADMIN_EMAIL',
  imports: [OnboardingHostModule],
});
