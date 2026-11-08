/**
 * Settings → Getting started (`/settings/getting-started`, RETRO-H3 #599).
 *
 * The platform's page (`@marinoscar/platform-web/onboarding/ui`): the user steps of
 * `GET /api/onboarding` with Skip and "Show the welcome again". Lazy-loaded; the card is in
 * `config/userSettingsSections.tsx`, the route in `App.tsx` (no permission: `user_settings:read`,
 * which every role holds, is all the API asks).
 */
import { GettingStartedPage } from '@marinoscar/platform-web/onboarding/ui';

export default function GettingStartedRoute() {
  return <GettingStartedPage />;
}
