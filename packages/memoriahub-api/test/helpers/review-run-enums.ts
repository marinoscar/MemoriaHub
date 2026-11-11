// =============================================================================
// The review-run vocabularies as the specs write them (RETRO-J9, #622)
// =============================================================================
//
// The specs that moved out of the web app wrote `ReviewRunSubject.burst_group` against the generated Prisma
// enums. The package imports no generated client, so these objects carry the same names and values; the
// contract's tuples (`REVIEW_RUN_SUBJECTS`, `REVIEW_RUN_ACTIONS`) are pinned to the database enums by the web
// app's `contract-enums.spec.ts`.
// =============================================================================

import type { ReviewRunAction as Action, ReviewRunSubject as Subject } from '@marinoscar/memoriahub-contract/review-runs';

export const ReviewRunSubject = {
  burst_group: 'burst_group',
  duplicate_group: 'duplicate_group',
  location_suggestion: 'location_suggestion',
} as const satisfies Record<Subject, Subject>;
export type ReviewRunSubject = Subject;

export const ReviewRunAction = {
  resolve_archive: 'resolve_archive',
  resolve_trash: 'resolve_trash',
  dismiss: 'dismiss',
  accept: 'accept',
  reject: 'reject',
} as const satisfies Record<Action, Action>;
export type ReviewRunAction = Action;
