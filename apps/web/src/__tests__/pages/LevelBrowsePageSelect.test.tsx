/**
 * Select-mode tests for LevelBrowsePage (/places/countries|regions|cities),
 * issue #407 — merge in context.
 *
 * The base browsing behaviour has its own spec at
 * `src/pages/Places/__tests__/LevelBrowsePage.test.tsx`; this file covers only
 * what #407 adds:
 *   - the affordance is absent WITHOUT `geo_settings:write` and present with
 *     it, and tiles keep navigating normally when not in select mode;
 *   - a merge from the country tier submits the tile's real `countryCode`,
 *     while region/city tiers submit `''` — the deliberate UNSCOPED sentinel,
 *     because `getExploreLocationLevel` aggregates those tiers across countries
 *     and never carries a code.
 *
 * `usePermissions` is deliberately NOT mocked: it derives from the AuthContext
 * the shared `render` already provides, so driving the real permission set is
 * both simpler and closer to production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getExploreLocationLevel: vi.fn(),
}));

vi.mock('../../services/locationGroups', async () => {
  const actual = await vi.importActual<typeof import('../../services/locationGroups')>(
    '../../services/locationGroups',
  );
  return {
    ...actual,
    listLocationGroups: vi.fn(),
    mergeLocationGroups: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LevelBrowsePage from '../../pages/Places/LevelBrowsePage';
import { useCircle } from '../../hooks/useCircle';
import { getExploreLocationLevel } from '../../services/media';
import { listLocationGroups, mergeLocationGroups } from '../../services/locationGroups';
import type { MergeLocationGroupsResult } from '../../services/locationGroups';

const mockUseCircle = vi.mocked(useCircle);
const mockGetLevel = vi.mocked(getExploreLocationLevel);
const mockListGroups = vi.mocked(listLocationGroups);
const mockMerge = vi.mocked(mergeLocationGroups);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function defaultCircleMock() {
  return {
    activeCircle: { id: 'circle-1', name: 'My Circle' },
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin' as const,
    circles: [],
    loading: false,
    setActiveCircle: vi.fn(),
    refreshCircles: vi.fn(),
  };
}

/** Mirrors the real merge payload — the name lives at `group.canonicalName`. */
function makeMergeResult(): MergeLocationGroupsResult {
  return {
    groupId: 'g-new',
    created: true,
    added: 2,
    skipped: 0,
    jobId: 'job-1',
    status: 'pending',
    group: {
      id: 'g-new',
      level: 'locality',
      canonicalName: 'The Woodlands',
      normalizedName: 'the woodlands',
      countryCode: '',
      memberCount: 2,
      itemCount: 1200,
      coverMediaItemId: null,
      coverThumbnailUrl: null,
      centerLat: null,
      centerLng: null,
      radiusKm: null,
      enabled: true,
      notes: null,
      aliases: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

/** An admin who also holds `geo_settings:write` — the only user who may merge. */
function makeGeoAdmin(): MockUser {
  return {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'geo_settings:read', 'geo_settings:write'],
  };
}

// ---------------------------------------------------------------------------

describe('LevelBrowsePage — select mode (#407)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockGetLevel.mockResolvedValue([]);
    mockListGroups.mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 200 } });
    mockMerge.mockResolvedValue(makeMergeResult());
  });

  // -------------------------------------------------------------------------
  describe('permission gating', () => {
    it('renders no Select toggle for a user without geo_settings:write', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: mockUser } });

      expect(await screen.findByText('Conroe')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^select$/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('location-selection-bar')).not.toBeInTheDocument();
      // No checkbox affordance at all — the tile is the plain browse button.
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(
        screen.getByRole('button', { name: /browse photos from conroe/i }),
      ).toBeInTheDocument();
    });

    it('renders the Select toggle for a geo_settings:write holder', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      expect(await screen.findByRole('button', { name: /^select$/i })).toBeInTheDocument();
    });

    it('still navigates normally while NOT in select mode', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /browse photos from conroe/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?locality=Conroe');
    });
  });

  // -------------------------------------------------------------------------
  describe('selection', () => {
    it('toggles selection instead of navigating, and counts photos', async () => {
      mockGetLevel.mockResolvedValue([
        { name: 'Conroe', count: 12, coverThumbnailUrl: null },
        { name: 'The Woodlands', count: 1188, coverThumbnailUrl: null },
      ]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Conroe' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select The Woodlands' }));

      expect(mockNavigate).not.toHaveBeenCalled();
      const bar = screen.getByTestId('location-selection-bar');
      expect(bar.textContent).toMatch(/2 selected · 1,200 photos/);
    });

    it('clears the selection when select mode is cancelled', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Conroe' }));
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(screen.queryByTestId('location-selection-bar')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^select$/i }));
      expect(screen.getByTestId('location-selection-bar').textContent).toMatch(/0 selected/);
    });

    it('disables Merge with nothing selected', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));

      expect(screen.getByRole('button', { name: /merge…/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('country scoping of the merge', () => {
    it('submits the UNSCOPED sentinel from the city tier', async () => {
      mockGetLevel.mockResolvedValue([
        { name: 'Conroe', count: 12, coverThumbnailUrl: null },
        { name: 'The Woodlands', count: 1188, coverThumbnailUrl: null },
      ]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Conroe' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select The Woodlands' }));
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith({
          level: 'locality',
          countryCode: '',
          values: ['Conroe', 'The Woodlands'],
          canonicalName: 'The Woodlands',
        });
      });
    });

    it('submits the UNSCOPED sentinel from the region tier', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Heredia', count: 40, coverThumbnailUrl: null }]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="regions" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Heredia' }));
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'region', countryCode: '' }),
        );
      });
    });

    it("submits the tile's real countryCode from the country tier", async () => {
      mockGetLevel.mockResolvedValue([
        { name: 'Costa Rica', countryCode: 'CR', count: 500, coverThumbnailUrl: null },
        { name: 'República de Costa Rica', countryCode: 'CR', count: 20, coverThumbnailUrl: null },
      ]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="countries" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Costa Rica' }));
      await user.click(
        screen.getByRole('checkbox', { name: 'Select República de Costa Rica' }),
      );
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith({
          level: 'country',
          countryCode: 'CR',
          values: ['Costa Rica', 'República de Costa Rica'],
          canonicalName: 'Costa Rica',
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('after the merge', () => {
    it('clears the selection and says the rebuild has to run first', async () => {
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Conroe' }));
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      // Generous timeout: the merge resolves through two awaited state updates
      // (dialog close, then the page's own snackbar), which under a loaded
      // parallel run can exceed findBy's 1s default.
      await waitFor(
        () => {
          expect(screen.getByText(/a rebuild is queued/i)).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
      expect(screen.queryByTestId('location-selection-bar')).not.toBeInTheDocument();
    });

    it('keeps the selection when the merge is rejected with a 409', async () => {
      const { ApiError } = await import('../../services/api');
      mockGetLevel.mockResolvedValue([{ name: 'Conroe', count: 12, coverThumbnailUrl: null }]);
      mockMerge.mockRejectedValue(
        new ApiError('"conroe" is already a member of "Conroe TX"', 409, undefined, {
          groupId: 'g-owner',
          groupName: 'Conroe TX',
        }),
      );

      const user = userEvent.setup();
      render(<LevelBrowsePage level="cities" />, { wrapperOptions: { user: makeGeoAdmin() } });

      await user.click(await screen.findByRole('button', { name: /^select$/i }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Conroe' }));
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(
        () => {
          expect(screen.getByText(/already in group "Conroe TX"/i)).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
      expect(screen.getByTestId('location-selection-bar').textContent).toMatch(/1 selected/);
    });
  });
});
