/**
 * Tests for useReviewQueues (issue #390, spec §4.5).
 *
 * Resolves the `REVIEW_QUEUES` registry against live feature flags and the
 * shared review-counts request. The three hooks it composes are mocked
 * directly here — `useFeatureFlags`, `useWorkflowSubjects`, and
 * `useReviewCounts` — so each case can drive the resolution logic without
 * touching the network.
 */
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import { ReviewQueueList } from '../../components/review/ReviewQueueList';
import type { ReviewCountsResponse } from '../../types/media';
import type { PictureEnhancementPolicy } from '../../services/features';

// This is a `.ts` file (not `.tsx`), so the loading-state integration test
// below builds its element tree with `createElement` rather than JSX —
// deliberate, not an oversight.
function reviewQueueListTree() {
  return createElement(MemoryRouter, null, createElement(ReviewQueueList, { variant: 'hub' }));
}

vi.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));
vi.mock('../../hooks/useWorkflowSubjects', () => ({
  useWorkflowsEnabled: vi.fn(),
}));
vi.mock('../../hooks/useReviewCounts', () => ({
  useReviewCounts: vi.fn(),
}));

import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { useWorkflowsEnabled } from '../../hooks/useWorkflowSubjects';
import { useReviewCounts } from '../../hooks/useReviewCounts';

const mockUseFeatureFlags = vi.mocked(useFeatureFlags);
const mockUseWorkflowsEnabled = vi.mocked(useWorkflowsEnabled);
const mockUseReviewCounts = vi.mocked(useReviewCounts);

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const FULL_COUNTS: ReviewCountsResponse = {
  pendingBurstGroups: 4,
  pendingDuplicateGroups: 6,
  pendingLocationSuggestions: 2,
  pendingEnhancements: 9,
};

function mockFeatureFlags(options: {
  features?: Record<string, boolean> | null;
  pictureEnhancement?: PictureEnhancementPolicy | null;
  isLoading?: boolean;
} = {}) {
  const { features = null, pictureEnhancement = null, isLoading = false } = options;
  mockUseFeatureFlags.mockReturnValue({
    features,
    pictureEnhancement,
    isLoading,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

function enhancerPolicy(enabled: boolean): PictureEnhancementPolicy {
  return { enabled, allowReplace: true, blockReplaceOnDownscale: false, model: 'gpt-image-1' };
}

function mockCounts(options: {
  data?: ReviewCountsResponse | null;
  isLoading?: boolean;
} = {}) {
  const { data = null, isLoading = false } = options;
  mockUseReviewCounts.mockReturnValue({
    data,
    isLoading,
    error: null,
    refetch: vi.fn(),
  });
}

describe('useReviewQueues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCounts();
  });

  // =========================================================================
  // Flag gating — the anti-flash rule
  // =========================================================================

  describe('flag gating', () => {
    it('resolves a queue whose flag is OFF but which still has pending residual work (issue #404 — the production regression)', () => {
      // The exact reported shape: duplicateDetection is off, but the server
      // still reports 6 pending duplicate groups (an earlier run, or the
      // admin backfill). Pure flag gating hid this row; the fix resolves it
      // anyway because there is real, reachable work behind it.
      mockFeatureFlags({
        features: { burstDetection: true, duplicateDetection: false, locationInference: true },
      });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      const keys = result.current.entries.map((e) => e.key);
      expect(keys).toContain('bursts');
      expect(keys).toContain('locations');
      expect(keys).toContain('duplicates');
      const duplicates = result.current.entries.find((e) => e.key === 'duplicates');
      expect(duplicates?.count).toBe(FULL_COUNTS.pendingDuplicateGroups);
      // `automations` carries no count key at all — off is off for it.
      expect(keys).not.toContain('automations');
    });

    it('does NOT resolve a queue whose flag is off AND whose count is 0 — the residual clause is not a blanket un-gate', () => {
      // Without this, a deployment that never turned duplicateDetection on
      // would carry a permanently dead row forever: the fix is "resolve when
      // there is real work", never "always resolve regardless of the flag".
      mockFeatureFlags({ features: { duplicateDetection: false } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: { ...FULL_COUNTS, pendingDuplicateGroups: 0 } });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).not.toContain('duplicates');
    });

    it('resolves a queue whose flag is ON regardless of its count, including the count: 0 drained state', () => {
      mockFeatureFlags({ features: { burstDetection: true } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: { ...FULL_COUNTS, pendingBurstGroups: 0 } });

      const { result } = renderHook(() => useReviewQueues());

      const bursts = result.current.entries.find((e) => e.key === 'bursts');
      expect(bursts).toBeDefined();
      expect(bursts?.count).toBe(0);
    });

    it('never resolves a SECONDARY entry on residual work — secondary entries stay purely flag-gated', () => {
      // automations is off; the counts payload is fully loaded and non-zero
      // everywhere it applies. Secondary entries carry no countKey at all
      // (count is always null for them), so there is nothing a residual
      // clause could key off even if one were mistakenly extended to them.
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).not.toContain('automations');
    });

    it('hides an entry whose flag is unresolved (null), not just false', () => {
      // `features` itself resolved (not loading), but simply lacks the key —
      // the real shape of an outage/never-configured flag.
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(null);

      const { result } = renderHook(() => useReviewQueues());

      const keys = result.current.entries.map((e) => e.key);
      expect(keys).not.toContain('bursts');
      expect(keys).not.toContain('duplicates');
      expect(keys).not.toContain('locations');
      expect(keys).not.toContain('enhancements');
      expect(keys).not.toContain('automations');
    });

    it('hides the enhancer entry when pictureEnhancement is null (unresolved)', () => {
      mockFeatureFlags({ features: {}, pictureEnhancement: null });
      mockUseWorkflowsEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).not.toContain('enhancements');
    });

    it('shows the enhancer entry only when pictureEnhancement.enabled === true', () => {
      mockFeatureFlags({ features: {}, pictureEnhancement: enhancerPolicy(true) });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).toContain('enhancements');
    });

    it('shows automations only when useWorkflowsEnabled() === true', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).toContain('automations');
    });

    it('insights always resolves — it carries no flag', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries.map((e) => e.key)).toContain('insights');
    });

    it('insights resolves even when every other feature is off/unresolved', () => {
      mockFeatureFlags({ features: null, pictureEnhancement: null });
      mockUseWorkflowsEnabled.mockReturnValue(null);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0].key).toBe('insights');
    });
  });

  // =========================================================================
  // totalPending
  // =========================================================================

  describe('totalPending', () => {
    it('sums every RESOLVED entry — enabled ones and residual (flag-off, count>0) ones alike — never an excluded (flag-off, count 0) one', () => {
      // bursts is enabled; duplicates is off but has residual work (resolves,
      // counts); locations and enhancements are off AND drained (excluded,
      // contribute nothing).
      mockFeatureFlags({
        features: { burstDetection: true, duplicateDetection: false, locationInference: false },
      });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({
        data: {
          pendingBurstGroups: 4,
          pendingDuplicateGroups: 6,
          pendingLocationSuggestions: 0,
          pendingEnhancements: 0,
        },
      });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.totalPending).toBe(10);
    });

    it('is 0 when no queue-producing feature is enabled, even with insights/automations present', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.totalPending).toBe(0);
    });

    it('treats a not-yet-loaded count (null) as contributing 0, never NaN', () => {
      mockFeatureFlags({ features: { burstDetection: true } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: null }); // still loading

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.totalPending).toBe(0);
    });
  });

  // =========================================================================
  // The counts request is now UNCONDITIONAL (issue #404) — the old
  // flag-derived `enabled` gate is gone entirely, because that gate was the
  // chicken-and-egg at the root of the bug: with every queue flag off, no
  // request fired, no counts arrived, and residual work could never be
  // discovered in the one configuration where it mattered most.
  // =========================================================================

  describe('useReviewCounts is called unconditionally', () => {
    it('calls useReviewCounts with no arguments when a counted queue feature is on', () => {
      mockFeatureFlags({ features: { locationInference: true } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith();
    });

    it('still calls useReviewCounts with no arguments when no counted queue feature is on, even with automations on', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(true); // automations only — carries no count
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith();
    });

    it('still calls useReviewCounts with no arguments when every flag is off/unresolved — this is exactly what makes residual-work discovery possible', () => {
      mockFeatureFlags({ features: null, pictureEnhancement: null });
      mockUseWorkflowsEnabled.mockReturnValue(null);
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith();
    });
  });

  // =========================================================================
  // count is null for the two secondary entries
  // =========================================================================

  describe('secondary entries carry no count', () => {
    it('insights.count and automations.count are always null, even when counts data is loaded', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(true);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      const insights = result.current.entries.find((e) => e.key === 'insights');
      const automations = result.current.entries.find((e) => e.key === 'automations');
      expect(insights?.count).toBeNull();
      expect(automations?.count).toBeNull();
    });
  });

  // =========================================================================
  // anyEnabled
  // =========================================================================

  describe('anyEnabled', () => {
    it('is true whenever at least one entry (including insights) resolves', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.anyEnabled).toBe(true);
    });

    it('reflects entries.length > 0 directly, including a residual (flag-off) entry', () => {
      mockFeatureFlags({ features: { duplicateDetection: false } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: { ...FULL_COUNTS, pendingDuplicateGroups: 6 } });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.anyEnabled).toBe(result.current.entries.length > 0);
      expect(result.current.anyEnabled).toBe(true);
    });
  });

  // =========================================================================
  // No-flash (issue #404): counts must not settle a beat after flags do.
  //
  // Before this fix, `isLoading` derived from `anyQueueEnabled && countsLoading`
  // — so with every queue flag off, the counts half of the loading state was
  // ignored entirely. A residual row could then only appear by POPPING IN
  // after `ReviewQueueList` had already rendered a list without it: the flags
  // settle first (fast, cached), `isLoading` goes false immediately, the list
  // renders with whatever `entries` looks like when `counts` is still `null`
  // (no residual rows resolve on a null count), and only THEN does the counts
  // request resolve and grow the list a row.
  //
  // A test that renders once, awaits everything, and checks the final state
  // cannot see this: the settled result is the SAME correct list either way.
  // Only observing the list DURING the gap between "flags known" and "counts
  // known" — and confirming it renders NOTHING (not a partial list) — proves
  // `isLoading` is actually gating on both.
  // =========================================================================

  describe('no premature settling while counts are still in flight', () => {
    it('useReviewQueues reports isLoading: true while counts have not resolved, even though flags already have', () => {
      mockFeatureFlags({ features: { duplicateDetection: false } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      // The counts promise has not resolved yet: `data` is still null and the
      // hook is still reporting `isLoading: true` for this instance.
      mockCounts({ data: null, isLoading: true });

      const { result } = renderHook(() => useReviewQueues());

      expect(result.current.isLoading).toBe(true);
    });

    it('ReviewQueueList shows its loading state while counts are in flight, then renders the complete list once — never a list that later grows the residual row', () => {
      mockFeatureFlags({ features: { duplicateDetection: false } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: null, isLoading: true });

      const { rerender } = render(reviewQueueListTree());

      // Mid-flight: a spinner, and — the property a "settled-state-only" test
      // cannot see — NO rows at all, not even a partial list missing the
      // eventual residual row.
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();

      // The counts promise settles: duplicateDetection is off, but 6 pending
      // duplicate groups are reported — the residual case from the
      // regression above.
      mockCounts({ data: { ...FULL_COUNTS, pendingDuplicateGroups: 6 }, isLoading: false });
      rerender(reviewQueueListTree());

      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Duplicates, 6 pending' })).toBeInTheDocument();
    });
  });
});
