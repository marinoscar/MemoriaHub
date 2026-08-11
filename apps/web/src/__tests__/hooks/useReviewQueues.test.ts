/**
 * Tests for useReviewQueues (issue #390, spec §4.5).
 *
 * Resolves the `REVIEW_QUEUES` registry against live feature flags and the
 * shared review-counts request. The three hooks it composes are mocked
 * directly here — `useFeatureFlags`, `useWorkflowSubjects`, and
 * `useReviewCounts` — so each case can drive the resolution logic without
 * touching the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import type { ReviewCountsResponse } from '../../types/media';
import type { PictureEnhancementPolicy } from '../../services/features';

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
    it('shows an entry only when its flag is === true', () => {
      mockFeatureFlags({
        features: { burstDetection: true, duplicateDetection: false, locationInference: true },
      });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      const keys = result.current.entries.map((e) => e.key);
      expect(keys).toContain('bursts');
      expect(keys).toContain('locations');
      expect(keys).not.toContain('duplicates');
      expect(keys).not.toContain('automations');
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
    it('sums ONLY the enabled queue entries, even when the API returned a count for a disabled one', () => {
      // Only bursts + duplicates enabled; locations and enhancements are off,
      // but the counts payload (as if from a shared response) still carries
      // numbers for all four.
      mockFeatureFlags({ features: { burstDetection: true, duplicateDetection: true } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts({ data: FULL_COUNTS });

      const { result } = renderHook(() => useReviewQueues());

      // FULL_COUNTS.pendingBurstGroups(4) + pendingDuplicateGroups(6) = 10.
      // Locations(2) and enhancements(9) must NOT contribute.
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
  // The counts request gate — the broadened form of the enhancer-only gate
  // =========================================================================

  describe('useReviewCounts gating', () => {
    it('calls useReviewCounts with enabled: true when ANY counted queue feature is on', () => {
      mockFeatureFlags({ features: { locationInference: true } });
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith({ enabled: true });
    });

    it('calls useReviewCounts with enabled: false when no counted queue feature is on, even with automations on', () => {
      mockFeatureFlags({ features: {} });
      mockUseWorkflowsEnabled.mockReturnValue(true); // automations only — carries no count
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith({ enabled: false });
    });

    it('calls useReviewCounts with enabled: false when every flag is off/unresolved', () => {
      mockFeatureFlags({ features: null, pictureEnhancement: null });
      mockUseWorkflowsEnabled.mockReturnValue(null);
      mockCounts();

      renderHook(() => useReviewQueues());

      expect(mockUseReviewCounts).toHaveBeenCalledWith({ enabled: false });
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
  });
});
