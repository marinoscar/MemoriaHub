/**
 * Admin → Settings → Setup guide (`/admin/settings/setup`, RETRO-H3 #599).
 *
 * The platform's page (`@marinoscar/platform-web/onboarding/ui`): the admin steps of
 * `GET /api/onboarding` in Required / Recommended / Optional groups, Re-check, Open the Doctor and
 * the Activation section (`GET /api/admin/onboarding/metrics`). Lazy-loaded; the card is in
 * `config/adminSections.tsx`, the route (gated on `system_settings:read`) in `App.tsx`.
 */
import { SetupGuidePage } from '@marinoscar/platform-web/onboarding/ui';

export default function SetupGuideRoute() {
  return <SetupGuidePage />;
}
