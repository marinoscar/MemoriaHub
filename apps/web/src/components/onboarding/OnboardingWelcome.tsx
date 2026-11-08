/**
 * The one-time welcome (RETRO-H3, #599): the platform `WelcomeDialog` with MemoriaHub's panes,
 * mounted once in the shell's `overlays` slot.
 *
 * The dialog opens while `onboarding.welcomeSeenAt` is unset; every way out (both buttons, Escape,
 * the backdrop) stores it. An ESTABLISHED account (one that had uploaded before onboarding shipped) is
 * marked instead and never sees it unasked (`platform/onboarding/establishedAccount.ts`).
 */
import { WelcomeDialog } from '@marinoscar/platform-web/onboarding/ui';

import { useEstablishedAccountMark } from '../../platform/onboarding/establishedAccount';
import { adminWelcomePane, userWelcomePane } from './memoriahubWelcomePanes';

export function OnboardingWelcome() {
  const hold = useEstablishedAccountMark();
  if (hold) return null;
  return <WelcomeDialog slots={{ userPane: userWelcomePane, adminPane: adminWelcomePane }} />;
}
