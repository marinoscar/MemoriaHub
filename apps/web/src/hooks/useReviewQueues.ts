/**
 * Resolve the Review inbox registry against live feature flags and counts.
 *
 * One hook, several consumers (issue #390): the hub page's queue list, the
 * sidebar's aggregate badge, and — from #392 — the desktop context pane. Having
 * them read one resolver is what keeps the badge, the list and the pane from
 * disagreeing about which queues exist or how many items are pending.
 *
 * It issues NO new request for the flags: `useFeatureFlags` and
 * `useWorkflowsEnabled` are both module-level caches the sidebar already reads.
 * The only network call is the counts one.
 *
 * RESOLUTION RULE — enabled OR has pending work (issue #404)
 * ---------------------------------------------------------
 * A `queue` entry resolves when its feature flag is on **or** the server says it
 * still holds pending items. Pure flag gating (the #390 behaviour) hid a row
 * whose queue was full: `MediaService.computeReviewCounts` reports
 * `pendingDuplicateGroups` UNCONDITIONALLY — it is not feature-gated — and
 * `DuplicatesPage` (like `BurstsPage` and `LocationSuggestionsPage`) renders and
 * works with the flag off, so the row was hiding a working page from a user who
 * had real work waiting. Groups created while the flag was on, or by
 * `POST /api/admin/duplicates/backfill`, stay resolvable in `duplicate_groups`
 * forever; gating them away orphans them. These three rows were ungated
 * entirely before #390, and spec §6.3 already states the principle: *keep the
 * destination, drop the badge*.
 *
 * `secondary` entries (Insights, Automations) keep PURE flag gating — they carry
 * no count, so "has pending work" is not a question that can be asked of them.
 */

import { useMemo } from 'react';
import type { ReviewCountsResponse } from '../types/media';
import type { ReviewQueueDef, ReviewQueueFlag } from '../config/reviewQueues';
import { REVIEW_QUEUES } from '../config/reviewQueues';
import { useFeatureFlags } from './useFeatureFlags';
import { useWorkflowsEnabled } from './useWorkflowSubjects';
import { useReviewCounts } from './useReviewCounts';

export interface ResolvedReviewQueue extends ReviewQueueDef {
  /**
   * Pending items in this queue.
   *
   * `null` for the two `secondary` entries, which are not queues and carry no
   * count — and also while the counts are still in flight, which is why a
   * consumer must distinguish `null` from `0`: `0` is a genuinely drained queue
   * (rendered as an em dash, and the trigger for the all-clear state), `null` is
   * "not known yet" or "not applicable".
   */
  count: number | null;
}

export interface UseReviewQueuesResult {
  /** Resolved entries only, in the registry's FIXED order — never sorted by count. */
  entries: ResolvedReviewQueue[];
  counts: ReviewCountsResponse | null;
  /**
   * Sum of the resolved queue counts — the aggregate badge on the Review
   * destination. Residual work behind a disabled flag COUNTS: the row is
   * reachable and the page acts on it, so hiding it from the badge would be the
   * same bug one level up.
   */
  totalPending: number;
  isLoading: boolean;
  /** False when nothing resolves at all — no flag on and no residual work. */
  anyEnabled: boolean;
}

export function useReviewQueues(): UseReviewQueuesResult {
  const { features, pictureEnhancement, isLoading: flagsLoading } = useFeatureFlags();
  const workflowsEnabled = useWorkflowsEnabled();

  // `=== true` everywhere, never a truthy check — the same convention `Sidebar`
  // documents: an entry must not flash in while the flags are still loading
  // (every source is null until then), and a flags outage, which resolves to
  // null rather than throwing, must HIDE the entry instead of guessing.
  const isFlagEnabled = useMemo(() => {
    return (flag: ReviewQueueFlag): boolean => {
      if (flag === null) return true;
      // Workflows has no entry in `features` — it is probed separately via
      // `GET /workflows/subjects`, the only gate a non-admin can read for it.
      if (flag === 'workflows') return workflowsEnabled === true;
      // The enhancer's client policy is its own object, not a `features` key,
      // and its `enabled` already folds in the env kill-switch server-side.
      if (flag === 'pictureEnhancement') return pictureEnhancement?.enabled === true;
      return features?.[flag] === true;
    };
  }, [features, pictureEnhancement, workflowsEnabled]);

  // The counts request is now UNGATED (issue #404) — `useReviewCounts` still
  // makes no request without an active circle, and that is the only condition
  // left on it.
  //
  // It has to be. The resolution rule below asks "does this queue hold pending
  // work?", and the previous gate derived `enabled` from the flag-enabled set —
  // so with every queue flag off, no request fired, no counts arrived, and
  // residual work could never be discovered. The row could not appear precisely
  // in the configuration where it most needed to. That is a genuine
  // chicken-and-egg, not an ordering bug, and the only way out is to stop asking
  // the flags for permission to ask the server.
  //
  // Paying for it unconditionally is justified: the Review destination itself
  // renders unconditionally and always wants an aggregate badge, so its counts
  // are needed unconditionally. `GET /api/media/review-counts` is the
  // purpose-built counts-only endpoint issue #204 created for exactly this shape
  // of caller — four integers, no thumbnail signing, no dashboard payload.
  // #204's concern was avoiding the FULL dashboard response, not this call.
  //
  // NOTE: `useReviewCounts`'s own `enabled` option and its `enabled: false` ⇒
  // no-request contract are untouched. Only this call site stopped passing it.
  const { data: counts, isLoading: countsLoading } = useReviewCounts();

  const entries = useMemo<ResolvedReviewQueue[]>(
    () =>
      REVIEW_QUEUES.map((def) => ({
        ...def,
        count: def.countKey && counts ? counts[def.countKey] : null,
      })).filter((entry) => {
        if (isFlagEnabled(entry.flag)) return true;
        // Residual work keeps a queue row alive even with its feature off. Not
        // applied to `secondary` entries: they have no count, so `count` is
        // always null there and this branch would be dead anyway — spelling the
        // group check out keeps that a stated rule rather than an accident of
        // the registry's current shape.
        return entry.group === 'queue' && (entry.count ?? 0) > 0;
      }),
    [isFlagEnabled, counts],
  );

  const totalPending = entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0);

  return {
    entries,
    counts,
    totalPending,
    // Three things must have answered before a consumer may render, and the
    // third is new in #404.
    //
    // `workflowsEnabled === null` means its probe has not resolved. It counts as
    // loading so a deep link to `/review/automations` waits for the answer
    // instead of being bounced to the hub as "disabled" a beat before the probe
    // says otherwise.
    //
    // `countsLoading` is now UNCONDITIONAL (it used to be `anyQueueEnabled &&
    // countsLoading`). Counts settle after flags, and a residual row exists only
    // once the counts arrive — so gating on the flags alone would render the
    // list, then pop an extra row in a beat later. Holding the existing loading
    // state until both halves have settled makes the list render ONCE, complete.
    // Safe against a stuck spinner: with no active circle `useReviewCounts`
    // reports `isLoading: false` immediately, and it always clears the flag in an
    // unconditional `finally`.
    isLoading: flagsLoading || workflowsEnabled === null || countsLoading,
    // Still meaningful, just measured against what actually resolved rather than
    // against the flag-enabled set: false means nothing at all is reachable
    // here — no flag on AND no residual work — which is the condition the
    // all-disabled empty state describes.
    anyEnabled: entries.length > 0,
  };
}
