/**
 * Tests for `useNavigationPrefs` (issue #392, epic #388, spec §5).
 *
 * `useUserSettings` is mocked directly (never the network layer) so each case
 * can drive settings state and the PATCH round trip precisely. The mock is
 * STATEFUL — `updateSettings` mutates a module-scoped `currentSettings` and the
 * `useUserSettings` mock always reads the latest value — so a successful pin
 * genuinely round-trips through a re-render, the same way the real hook's
 * `settings` state would update after a real PATCH resolves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useNavigationPrefs,
  usePinnedDestinations,
  PINNABLE_DESTINATIONS,
  isPinnableKey,
  NAVIGATION_MAX_PINNED,
} from '../../hooks/useNavigationPrefs';
import { COLLECTIONS } from '../../config/collections';
import { REVIEW_QUEUES } from '../../config/reviewQueues';
import type { ReviewQueueKey } from '../../config/reviewQueues';
import type { UserSettings, UserSettingsUpdate } from '../../types';

vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));
vi.mock('../../hooks/useMemoriesEnabled', () => ({
  useMemoriesEnabled: vi.fn(),
}));

import { useUserSettings } from '../../hooks/useUserSettings';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';

const mockUseUserSettings = vi.mocked(useUserSettings);
const mockUseMemoriesEnabled = vi.mocked(useMemoriesEnabled);

// ---------------------------------------------------------------------------
// Stateful useUserSettings mock
// ---------------------------------------------------------------------------

function baseSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

let currentSettings: UserSettings;
let mockUpdateSettings: ReturnType<typeof vi.fn>;

/**
 * Wires `useUserSettings` so `updateSettings` merges the `navigation` patch
 * field-wise into `currentSettings` and every subsequent hook call reads the
 * updated value — mirroring the real hook's `settings` state after a PATCH
 * resolves. `impl` lets a case override `updateSettings` to reject.
 */
function wireUserSettings(
  initial: UserSettings,
  impl: (patch: UserSettingsUpdate) => Promise<void> = async (patch) => {
    currentSettings = {
      ...currentSettings,
      navigation: {
        ...currentSettings.navigation,
        ...patch.navigation,
      },
      version: currentSettings.version + 1,
    };
  },
) {
  currentSettings = initial;
  mockUpdateSettings = vi.fn(impl);
  mockUseUserSettings.mockImplementation(() => ({
    settings: currentSettings,
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings: mockUpdateSettings,
    updateTheme: vi.fn(),
    updateProfile: vi.fn(),
    refresh: vi.fn(),
  }));
}

describe('useNavigationPrefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMemoriesEnabled.mockReturnValue(true);
  });

  // =========================================================================
  // Absent-means-default, and a default is never written back
  // =========================================================================

  describe('absent namespace', () => {
    it('resolves to no pins and an expanded rail', () => {
      wireUserSettings(baseSettings());

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.pinned).toEqual([]);
      expect(result.current.railCollapsed).toBe(false);
    });

    it('never PATCHes a default back on mount', async () => {
      wireUserSettings(baseSettings());

      renderHook(() => useNavigationPrefs());

      // Give any stray mount effect a chance to fire before asserting the
      // negative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('an explicit railCollapsed: false is indistinguishable from absent', () => {
      wireUserSettings(baseSettings({ navigation: { railCollapsed: false } }));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(false);
    });
  });

  // =========================================================================
  // toggleRailCollapsed — PATCHes ONLY the navigation namespace
  // =========================================================================

  describe('toggleRailCollapsed', () => {
    it('PATCHes only { navigation: { railCollapsed } }, not the whole settings blob', async () => {
      wireUserSettings(baseSettings());

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => {
        result.current.toggleRailCollapsed();
      });

      expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenCalledWith({ navigation: { railCollapsed: true } });
    });

    it('flips back to false on a second toggle', async () => {
      wireUserSettings(baseSettings({ navigation: { railCollapsed: true } }));

      const { result } = renderHook(() => useNavigationPrefs());
      expect(result.current.railCollapsed).toBe(true);

      act(() => {
        result.current.toggleRailCollapsed();
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith({ navigation: { railCollapsed: false } });
      await waitFor(() => expect(result.current.railCollapsed).toBe(false));
    });
  });

  // =========================================================================
  // Optimistic update + revert on failure
  // =========================================================================

  describe('optimistic update', () => {
    it('applies the new value immediately, before the write settles', () => {
      let resolveWrite: () => void;
      wireUserSettings(
        baseSettings(),
        () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
      );

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => {
        result.current.toggleRailCollapsed();
      });

      // Immediate — no await — the write has not resolved yet.
      expect(result.current.railCollapsed).toBe(true);

      // Settle the pending write so the test doesn't leak a dangling act warning.
      act(() => resolveWrite());
    });

    it('reverts to the stored value when the write fails', async () => {
      wireUserSettings(baseSettings(), async () => {
        throw new Error('network down');
      });

      const { result } = renderHook(() => useNavigationPrefs());
      expect(result.current.railCollapsed).toBe(false);

      act(() => {
        result.current.toggleRailCollapsed();
      });
      // Applied optimistically, before the (about-to-fail) write settles.
      expect(result.current.railCollapsed).toBe(true);

      // The overlay is cleared once the rejected write settles, and `stored`
      // (unchanged by the failed PATCH) takes back over.
      await waitFor(() => expect(result.current.railCollapsed).toBe(false));
    });
  });

  // =========================================================================
  // pin / unpin round-trip
  // =========================================================================

  describe('pin / unpin', () => {
    it('pin() adds the key and round-trips through settings', async () => {
      wireUserSettings(baseSettings());

      const { result } = renderHook(() => useNavigationPrefs());
      expect(result.current.isPinned('albums')).toBe(false);

      act(() => {
        result.current.pin('albums');
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith({ navigation: { pinned: ['albums'] } });
      await waitFor(() => expect(result.current.pinned).toEqual(['albums']));
      expect(result.current.isPinned('albums')).toBe(true);
    });

    it('pinning an already-pinned key is a no-op', () => {
      wireUserSettings(baseSettings({ navigation: { pinned: ['albums'] } }));

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => {
        result.current.pin('albums');
      });

      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('unpin() removes the key and round-trips through settings', async () => {
      wireUserSettings(baseSettings({ navigation: { pinned: ['albums', 'bursts'] } }));

      const { result } = renderHook(() => useNavigationPrefs());
      expect(result.current.pinned).toEqual(['albums', 'bursts']);

      act(() => {
        result.current.unpin('albums');
      });

      expect(mockUpdateSettings).toHaveBeenCalledWith({ navigation: { pinned: ['bursts'] } });
      await waitFor(() => expect(result.current.pinned).toEqual(['bursts']));
    });

    it('unpinning a key that is not pinned is a no-op', () => {
      wireUserSettings(baseSettings());

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => {
        result.current.unpin('albums');
      });

      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // The 6-cap — enforced client-side via canPin
  // =========================================================================

  describe('the 6-pin cap', () => {
    const sixPins = ['albums', 'people', 'places', 'favorites', 'archive', 'trash'];

    it('canPin is false once 6 are pinned', () => {
      wireUserSettings(baseSettings({ navigation: { pinned: sixPins } }));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.pinned).toHaveLength(NAVIGATION_MAX_PINNED);
      expect(result.current.canPin).toBe(false);
    });

    it('a 7th pin() is refused locally — no PATCH is sent', () => {
      wireUserSettings(baseSettings({ navigation: { pinned: sixPins } }));

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => {
        result.current.pin('map');
      });

      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(result.current.pinned).toHaveLength(NAVIGATION_MAX_PINNED);
    });

    it('canPin is true with fewer than 6 pinned', () => {
      wireUserSettings(baseSettings({ navigation: { pinned: ['albums'] } }));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.canPin).toBe(true);
    });
  });

  // =========================================================================
  // Unknown stored keys degrade to "not pinned" — never a throw
  // =========================================================================

  describe('unknown stored keys', () => {
    it('drops an unrecognised key on read without throwing', () => {
      wireUserSettings(
        baseSettings({ navigation: { pinned: ['albums', 'a-future-destination'] } }),
      );

      expect(() => renderHook(() => useNavigationPrefs())).not.toThrow();

      const { result } = renderHook(() => useNavigationPrefs());
      expect(result.current.pinned).toEqual(['albums']);
    });

    it('drops duplicate entries and caps the sanitised list at 6', () => {
      wireUserSettings(
        baseSettings({
          navigation: {
            pinned: ['albums', 'albums', 'people', 'places', 'favorites', 'archive', 'trash', 'map'],
          },
        }),
      );

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.pinned).toEqual(['albums', 'people', 'places', 'favorites', 'archive', 'trash']);
    });
  });

  // =========================================================================
  // A pin whose feature is off stays in STORAGE — usePinnedDestinations is
  // what filters it for render (see the dedicated describe block below).
  // =========================================================================

  it('keeps a feature-gated pin (memories) in storage even while its own useMemoriesEnabled call is unrelated to this hook', () => {
    wireUserSettings(baseSettings({ navigation: { pinned: ['memories'] } }));

    const { result } = renderHook(() => useNavigationPrefs());

    // useNavigationPrefs itself never calls useMemoriesEnabled — only
    // usePinnedDestinations does — so the stored key survives regardless of
    // the feature flag's state.
    expect(result.current.pinned).toEqual(['memories']);
  });

  // =========================================================================
  // isPinnableKey / PINNABLE_DESTINATIONS — the shared registry
  // =========================================================================

  describe('PINNABLE_DESTINATIONS', () => {
    it('has exactly the API\'s 14 pinnable keys', () => {
      const expectedKeys = [
        ...COLLECTIONS.map((c) => c.key),
        'bursts',
        'duplicates',
        'locations',
        'enhancements',
        'review-insights',
        'automations',
      ];

      expect(PINNABLE_DESTINATIONS).toHaveLength(14);
      expect(PINNABLE_DESTINATIONS.map((e) => e.key).sort()).toEqual(expectedKeys.sort());
    });

    it('every entry resolves to a non-empty label, a route, and an Icon component — never undefined', () => {
      for (const entry of PINNABLE_DESTINATIONS) {
        expect(entry.label).toBeTruthy();
        expect(entry.path).toMatch(/^\//);
        expect(entry.Icon).toBeDefined();
      }
    });

    it('isPinnableKey is true for every registry key and false for an arbitrary string', () => {
      for (const entry of PINNABLE_DESTINATIONS) {
        expect(isPinnableKey(entry.key)).toBe(true);
      }
      expect(isPinnableKey('not-a-real-destination')).toBe(false);
      // The four PRIMARY destinations are not pinnable — pinning Photos would
      // be meaningless (spec §5).
      expect(isPinnableKey('photos')).toBe(false);
      expect(isPinnableKey('collections')).toBe(false);
      expect(isPinnableKey('review')).toBe(false);
      expect(isPinnableKey('search')).toBe(false);
    });

    it("the Review-derived entries resolve through the SAME reviewQueuePath() the pane's own rows use", () => {
      const bursts = PINNABLE_DESTINATIONS.find((e) => e.key === 'bursts');
      expect(bursts?.path).toBe('/review/bursts');
    });
  });

  // =========================================================================
  // usePinnedDestinations — the render-time feature-flag filter
  // =========================================================================

  describe('usePinnedDestinations', () => {
    const enabledReviewEntries = REVIEW_QUEUES.filter(
      (q): q is typeof q & { key: ReviewQueueKey } => q.key !== 'automations',
    );

    it('resolves a plain, non-gated pin (albums) to a renderable row', () => {
      mockUseMemoriesEnabled.mockReturnValue(true);
      const { result } = renderHook(() => usePinnedDestinations(['albums'], enabledReviewEntries));

      expect(result.current).toHaveLength(1);
      expect(result.current[0].key).toBe('albums');
      expect(result.current[0].path).toBe('/albums');
    });

    it('drops a memories pin from RENDER when the memories feature is off', () => {
      mockUseMemoriesEnabled.mockReturnValue(false);

      const { result } = renderHook(() =>
        usePinnedDestinations(['memories', 'albums'], enabledReviewEntries),
      );

      expect(result.current.map((e) => e.key)).toEqual(['albums']);
    });

    it('restores the memories pin to render once the feature flips back on — the storage value never changed', () => {
      mockUseMemoriesEnabled.mockReturnValue(false);
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => {
          mockUseMemoriesEnabled.mockReturnValue(enabled);
          return usePinnedDestinations(['memories'], enabledReviewEntries);
        },
        { initialProps: { enabled: false } },
      );
      expect(result.current).toHaveLength(0);

      rerender({ enabled: true });

      expect(result.current.map((e) => e.key)).toEqual(['memories']);
    });

    it('drops a review-queue pin whose queue is not in the caller-resolved enabled set', () => {
      mockUseMemoriesEnabled.mockReturnValue(true);
      // "automations" filtered out of the caller's enabled list, mirroring a
      // workflows-disabled deployment.
      const { result } = renderHook(() =>
        usePinnedDestinations(['automations', 'bursts'], enabledReviewEntries),
      );

      expect(result.current.map((e) => e.key)).toEqual(['bursts']);
    });

    it('preserves pinned order', () => {
      mockUseMemoriesEnabled.mockReturnValue(true);
      const { result } = renderHook(() =>
        usePinnedDestinations(['trash', 'albums', 'bursts'], enabledReviewEntries),
      );

      expect(result.current.map((e) => e.key)).toEqual(['trash', 'albums', 'bursts']);
    });
  });
});
