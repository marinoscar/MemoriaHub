/**
 * Which review queue a run belongs to, in the order of the `ReviewRunSubject` database enum.
 *
 * @stability stable
 */
export const REVIEW_RUN_SUBJECTS = ['burst_group', 'duplicate_group', 'location_suggestion'] as const;

/**
 * One review queue subject.
 *
 * @stability stable
 */
export type ReviewRunSubject = (typeof REVIEW_RUN_SUBJECTS)[number];

/**
 * The bulk action a run performs, in the order of the `ReviewRunAction` database enum.
 * `resolve_archive`, `resolve_trash` and `dismiss` apply to the burst and
 * duplicate queues; `accept` and `reject` to location suggestions.
 *
 * @stability stable
 */
export const REVIEW_RUN_ACTIONS = ['resolve_archive', 'resolve_trash', 'dismiss', 'accept', 'reject'] as const;

/**
 * One review run action.
 *
 * @stability stable
 */
export type ReviewRunAction = (typeof REVIEW_RUN_ACTIONS)[number];
