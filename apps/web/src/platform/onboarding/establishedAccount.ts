/**
 * "Already active" accounts are not greeted as new (RETRO-H3, #599).
 *
 * Onboarding ships into deployments full of people who have used MemoriaHub for months. The platform
 * welcome dialog opens for anybody whose `onboarding.welcomeSeenAt` is unset — that is EVERY existing
 * account the first time it loads the new shell — and the banner would then announce "1 of 3
 * required steps left" to an administrator who set the deployment up a year ago.
 *
 * The rule: an account whose `memoriahub.first_upload` step is already DONE the first time it loads
 * onboarding (and that has never seen the welcome nor put a checklist away) is ESTABLISHED. The shell
 * writes once, `{ establishedAt, welcomeSeenAt, checklistDismissedAt, adminDismissedAt }` = now, and
 * renders neither the dialog nor the banner meanwhile. `establishedAt` is MemoriaHub's own field
 * (`extendOnboardingSettings`, `apps/api/src/platform/onboarding/onboarding.settings.ts`) and is never
 * cleared, so the "Getting started" menu item (which clears the three platform fields) still brings
 * the welcome and the checklists back on request, and the mark is never written twice.
 *
 * The checklists themselves stay reachable through the Setup guide and Get started cards.
 */
import { useEffect, useRef } from 'react';
import { useOnboarding, type OnboardingResponse } from '@marinoscar/platform-web/onboarding/headless';

/** The activation step (`apps/api/src/platform/onboarding/onboarding.steps.ts`). PERMANENT id. */
export const FIRST_UPLOAD_STEP_ID = 'memoriahub.first_upload';

/** MemoriaHub's field in the `onboarding` namespace. */
export const ESTABLISHED_AT_FIELD = 'establishedAt';

/** Whether this state belongs to an established account that has not been marked yet. */
export function needsEstablishedMark(state: OnboardingResponse | null): boolean {
  if (!state?.settings) return false;
  const settings = state.settings as Record<string, unknown>;
  if (settings[ESTABLISHED_AT_FIELD]) return false;
  if (state.settings.welcomeSeenAt !== null || state.settings.checklistDismissedAt !== null) return false;
  const firstUpload = state.user?.steps.find((step) => step.id === FIRST_UPLOAD_STEP_ID);
  return firstUpload?.status === 'done';
}

/**
 * Marks an established account once. Returns `true` while the welcome and the banner must stay
 * hidden: until the first read settles, and until the mark is applied (the provider's optimistic
 * overlay applies it at once, so that is a single render).
 */
export function useEstablishedAccountMark(): boolean {
  const { state, isLoading, update } = useOnboarding();
  const written = useRef(false);
  const pending = needsEstablishedMark(state);

  useEffect(() => {
    if (!pending || written.current) return;
    written.current = true;
    const now = new Date().toISOString();
    void update({
      [ESTABLISHED_AT_FIELD]: now,
      welcomeSeenAt: now,
      checklistDismissedAt: now,
      adminDismissedAt: now,
    });
  }, [pending, update]);

  return isLoading || pending;
}
