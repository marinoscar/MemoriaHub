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
 * The only network call is the counts one, and it is gated (below) so a
 * deployment with every review feature off never makes it.
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
  /** Enabled entries only, in the registry's FIXED order — never sorted by count. */
  entries: ResolvedReviewQueue[];
  counts: ReviewCountsResponse | null;
  /** Sum of the enabled queue counts — the aggregate badge on the Review destination. */
  totalPending: number;
  isLoading: boolean;
  /** False when every entry is gated off, i.e. no review feature is enabled at all. */
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

  const enabledDefs = useMemo(
    () => REVIEW_QUEUES.filter((def) => isFlagEnabled(def.flag)),
    [isFlagEnabled],
  );

  // The counts request is gated on at least one COUNTED queue being enabled.
  // Insights and Automations resolve without counts, so a deployment running
  // only those two must not pay for the request — this is the broadened form of
  // the enhancer-only gate the sidebar used to apply (issue #204).
  const anyQueueEnabled = enabledDefs.some((def) => def.countKey !== null);
  const { data: counts, isLoading: countsLoading } = useReviewCounts({
    enabled: anyQueueEnabled,
  });

  const entries = useMemo<ResolvedReviewQueue[]>(
    () =>
      enabledDefs.map((def) => ({
        ...def,
        count: def.countKey && counts ? counts[def.countKey] : null,
      })),
    [enabledDefs, counts],
  );

  // Only enabled queues contribute: a feature that is off must not inflate the
  // badge with work the user has no surface to do.
  const totalPending = entries.reduce((sum, entry) => sum + (entry.count ?? 0), 0);

  return {
    entries,
    counts,
    totalPending,
    // `workflowsEnabled === null` means its probe has not resolved. It counts as
    // loading so a deep link to `/review/automations` waits for the answer
    // instead of being bounced to the hub as "disabled" a beat before the probe
    // says otherwise.
    isLoading:
      flagsLoading || workflowsEnabled === null || (anyQueueEnabled && countsLoading),
    anyEnabled: enabledDefs.length > 0,
  };
}
