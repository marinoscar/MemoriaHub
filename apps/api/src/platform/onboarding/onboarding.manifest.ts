import {
  ONBOARDING_STEP_IDS,
  PLATFORM_ONBOARDING_FACTS,
  PLATFORM_ONBOARDING_STEPS,
  registerActivationMilestone,
  registerOnboardingFact,
  registerOnboardingStep,
} from '@marinoscar/platform-api/onboarding';

import { MEMORIAHUB_ONBOARDING_FACT_DEFS } from './onboarding.facts';
import { MEMORIAHUB_ONBOARDING_STEP_DEFS, MEMORIAHUB_ONBOARDING_STEP_IDS } from './onboarding.steps';

// =============================================================================
// MemoriaHub's onboarding manifest (RETRO-H3, #599)
// =============================================================================
//
// Registers, in this order: the platform's facts and steps, MemoriaHub's facts and steps, then the
// activation milestone. Registration is all-or-nothing per call, so a typo fails at import; the boot
// (`assertOnboardingRegistries`) fails when a step names an unregistered fact.
//
// TWO PLATFORM BUILT-INS ARE LEFT OUT, each with its reason:
//
//   admin.storage  Its page (`/admin/settings/storage`) and permission (`storage_config:read`) are the
//                  platform storage slice's, which MemoriaHub does not mount yet (RETRO-D1): no such
//                  route or permission exists here, so the step could never be shown. MemoriaHub's own
//                  `memoriahub.storage_ready` (storage_settings:read, /admin/settings/storage/providers)
//                  takes its place until the storage slice lands and the built-in can be reused.
//   admin.ai       It checks the PLATFORM AI runtime (`ai.enabled`, `ai.providers`), which no MemoriaHub
//                  feature calls yet (RETRO-E2), and links to `/admin/settings/ai`, which here is
//                  MemoriaHub's own provider page (ai_settings:read). It would nag an administrator to
//                  turn on something nothing uses; `memoriahub.enable_tagging` asks the real question.
//
// `admin.email` IS MemoriaHub's "email ready" step (the issue's `memoriahub.email_ready`, "platform step
// if present"): the email slice is the platform's since RETRO-D2, and so is its Doctor check
// `email.config`. `admin.push` stays registered; it is omitted until its Doctor check `push.vapid` is
// registered (the notifications slice, RETRO-D3). `admin.org-invite` needs a data-port member this
// single-organization app does not bind, so it is never shown.
//
// IMPORTED BY `onboarding.config.ts` (and so by `app.module.ts`). The stored `onboarding` namespace's
// merge refuses a `skipped` id that is not a registered, skippable step, so the registry must be
// filled in any process that serves `PATCH /api/user-settings`. Module scope runs once per module
// registry, so no guard flag is needed.
// =============================================================================

/** The platform built-ins MemoriaHub does not register (see the header). */
export const EXCLUDED_PLATFORM_STEP_IDS: readonly string[] = [ONBOARDING_STEP_IDS.STORAGE, ONBOARDING_STEP_IDS.AI];

registerOnboardingFact(...PLATFORM_ONBOARDING_FACTS, ...MEMORIAHUB_ONBOARDING_FACT_DEFS);

registerOnboardingStep(
  ...PLATFORM_ONBOARDING_STEPS.filter((step) => !EXCLUDED_PLATFORM_STEP_IDS.includes(step.id)),
  ...MEMORIAHUB_ONBOARDING_STEP_DEFS,
);

// The event onboarding exists to cause: the first media item a new user registers. Activated means
// within 7 days of sign-up. Counts only; the expression is developer-authored and has no `;`.
registerActivationMilestone({
  id: 'first_upload',
  label: 'First upload',
  windowDays: 7,
  firstReachedAtSql: '(SELECT MIN(m.created_at) FROM media_items m WHERE m.added_by_id = c.id)',
});

/** Named here so the milestone and its step cannot drift apart in a reader's head. */
export const ACTIVATION_STEP_ID = MEMORIAHUB_ONBOARDING_STEP_IDS.FIRST_UPLOAD;
