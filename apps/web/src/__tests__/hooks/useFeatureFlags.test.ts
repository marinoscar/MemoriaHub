/**
 * Unit tests for useFeatureFlags.
 *
 * Covers:
 *  - Returns the {features, pictureEnhancement, isLoading, error, refresh} shape
 *    once the fetch resolves.
 *  - Module-level cache dedup: two consumers mounted concurrently issue only
 *    ONE network request (`getFeatures` called once). `clearFeatureFlagsCache()`
 *    is called in `beforeEach` since the cache is module-scoped and would
 *    otherwise leak across tests.
 *  - A failed fetch is NOT cached — features/pictureEnhancement stay null,
 *    error is set, and it never throws; a later call retries the network.
 *  - refresh() busts the cache and re-fetches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useFeatureFlags,
  clearFeatureFlagsCache,
} from '../../hooks/useFeatureFlags';
import { ApiError } from '../../services/api';
import type { FeatureFlags } from '../../services/features';

// ---------------------------------------------------------------------------
// Mock the features service module
// ---------------------------------------------------------------------------
vi.mock('../../services/features', () => ({
  getFeatures: vi.fn(),
}));

import { getFeatures } from '../../services/features';

const mockGetFeatures = vi.mocked(getFeatures);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeFeatureFlags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    features: { pictureEnhancement: true },
    pictureEnhancement: {
      enabled: true,
      allowReplace: true,
      blockReplaceOnDownscale: false,
      model: 'gpt-image-1',
    },
    ...overrides,
  };
}

describe('useFeatureFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFeatureFlagsCache();
  });

  // -------------------------------------------------------------------------
  describe('shape', () => {
    it('returns features/pictureEnhancement/isLoading/error/refresh, populated after load', async () => {
      const flags = makeFeatureFlags();
      mockGetFeatures.mockResolvedValue(flags);

      const { result } = renderHook(() => useFeatureFlags());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.features).toBeNull();
      expect(result.current.pictureEnhancement).toBeNull();
      expect(result.current.error).toBeNull();
      expect(typeof result.current.refresh).toBe('function');

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.features).toEqual(flags.features);
      expect(result.current.pictureEnhancement).toEqual(flags.pictureEnhancement);
      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('module-level cache dedup', () => {
    it('issues only one network request when two consumers mount concurrently', async () => {
      mockGetFeatures.mockResolvedValue(makeFeatureFlags());

      const { result: a } = renderHook(() => useFeatureFlags());
      const { result: b } = renderHook(() => useFeatureFlags());

      await waitFor(() => {
        expect(a.current.isLoading).toBe(false);
        expect(b.current.isLoading).toBe(false);
      });

      expect(mockGetFeatures).toHaveBeenCalledTimes(1);
      expect(a.current.features).toEqual(b.current.features);
    });

    it('reuses the cached value on a later mount without a second network call', async () => {
      mockGetFeatures.mockResolvedValue(makeFeatureFlags());

      const first = renderHook(() => useFeatureFlags());
      await waitFor(() => expect(first.result.current.isLoading).toBe(false));

      const second = renderHook(() => useFeatureFlags());
      await waitFor(() => expect(second.result.current.isLoading).toBe(false));

      expect(mockGetFeatures).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('failure handling', () => {
    it('does not throw; leaves features/pictureEnhancement null and sets error', async () => {
      mockGetFeatures.mockRejectedValue(new ApiError('Feature flags unavailable', 500));

      const { result } = renderHook(() => useFeatureFlags());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.features).toBeNull();
      expect(result.current.pictureEnhancement).toBeNull();
      expect(result.current.error).toBe('Feature flags unavailable');
    });

    it('falls back to a generic message for a non-ApiError throw', async () => {
      mockGetFeatures.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useFeatureFlags());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Failed to load feature flags');
    });

    it('does not cache a failure — a later mount retries the network', async () => {
      mockGetFeatures.mockRejectedValueOnce(new Error('boom'));

      const first = renderHook(() => useFeatureFlags());
      await waitFor(() => expect(first.result.current.isLoading).toBe(false));
      expect(first.result.current.error).toBe('Failed to load feature flags');

      mockGetFeatures.mockResolvedValueOnce(makeFeatureFlags());
      const second = renderHook(() => useFeatureFlags());
      await waitFor(() => expect(second.result.current.isLoading).toBe(false));

      expect(second.result.current.error).toBeNull();
      expect(second.result.current.features).toEqual(makeFeatureFlags().features);
      expect(mockGetFeatures).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('refresh()', () => {
    it('busts the cache and re-fetches', async () => {
      mockGetFeatures.mockResolvedValue(makeFeatureFlags());

      const { result } = renderHook(() => useFeatureFlags());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(mockGetFeatures).toHaveBeenCalledTimes(1);

      const updated = makeFeatureFlags({ features: { pictureEnhancement: false } });
      mockGetFeatures.mockResolvedValueOnce(updated);

      await result.current.refresh();

      await waitFor(() => {
        expect(result.current.features).toEqual(updated.features);
      });
      expect(mockGetFeatures).toHaveBeenCalledTimes(2);
    });
  });
});
