import { extendOnboardingSettings } from '@marinoscar/platform-api/onboarding';
import { z } from 'zod';

// =============================================================================
// MemoriaHub's field in the `onboarding` user-settings namespace (RETRO-H3, #599)
// =============================================================================
//
// `establishedAt` (ISO datetime): set ONCE, by the web shell, for an account that had already
// uploaded media when it first loaded onboarding (`memoriahub.first_upload` already done and no
// welcome ever seen). The same write marks the welcome seen and both checklists dismissed, so an
// account that was active before onboarding shipped is not greeted as new. It is never cleared:
// the "Getting started" menu item (`reopen`) clears the platform fields only, so the dialog and the
// checklists still come back on request. Absent for every new account.
// =============================================================================

export const MEMORIAHUB_ONBOARDING_SETTINGS_EXTENSION = extendOnboardingSettings({
  establishedAt: z.string().datetime({ offset: true }).optional(),
});
