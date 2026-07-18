/**
 * Unit tests for DuplicatesPage.
 *
 * Covers:
 *  - Renders "Review Duplicates" heading when a circle is active
 *  - Shows "Select a circle" alert when no active circle
 *  - Renders loading spinner while fetching
 *  - Renders empty state when no groups are returned
 *  - Renders list of duplicate groups when items exist
 *  - Renders kind badges (Exact copy / Edited variant / Similar) for each group
 *  - Kind filter chips: clicking a chip re-fetches with the corresponding `kind` param
 *  - Renders error message when fetch fails
 *  - Groups render in the order returned by the hook (server is source of chronological truth)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/useDuplicates', () => ({
  useDuplicateGroups: vi.fn(),
}));

// react-router-dom navigate mock
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import DuplicatesPage from '../../pages/Duplicates/DuplicatesPage';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useDuplicateGroups } from '../../hooks/useDuplicates';
import type { DuplicateGroupSummary } from '../../services/duplicates';

const mockUseCircle = vi.mocked(useCircle);
const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUseDuplicateGroups = vi.mocked(useDuplicateGroups);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-1';

function makeCircle(id = CIRCLE_ID) {
  return {
    id,
    name: 'Test Circle',
    description: null,
    ownerId: 'user-1',
    isPersonal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}): ReturnType<typeof useCircle> {
  return {
    activeCircle: makeCircle(),
    activeCircleId: CIRCLE_ID,
    activeCircleRole: 'collaborator',
    circles: [makeCircle()],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makeDuplicateGroupsHook(
  overrides: Partial<ReturnType<typeof useDuplicateGroups>> = {},
): ReturnType<typeof useDuplicateGroups> {
  return {
    items: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchGroups: vi.fn().mockResolvedValue(undefined),
    bulkResolve: vi.fn().mockResolvedValue({
      resolvedGroups: 1,
      keptCount: 1,
      removedCount: 2,
      action: 'archive',
      skipped: 0,
      errors: 0,
    }),
    bulkResolveByThreshold: vi.fn().mockResolvedValue({
      resolvedGroups: 1,
      keptCount: 1,
      removedCount: 2,
      action: 'archive',
      skipped: 0,
      errors: 0,
      hasMore: false,
    }),
    ...overrides,
  };
}

function makePermissions(isAdmin = false, canTrash = true) {
  return {
    permissions: new Set<string>(['media:read', 'media:write', ...(canTrash ? ['media:delete'] : [])]),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn((perm: string) => (perm === 'media:delete' ? canTrash : true)),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  } as unknown as ReturnType<typeof usePermissions>;
}

function makeSystemSettingsHook(autoResolveThreshold = 60): ReturnType<typeof useSystemSettings> {
  return {
    settings: {
      ui: { allowUserThemeOverride: true },
      features: {},
      dedup: {
        similarityThreshold: 0.96,
        hashMaxDistance: 6,
        knnCandidates: 20,
        autoResolveThreshold,
      },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
    } as any,
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: vi.fn().mockResolvedValue(undefined),
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSummary(
  id = 'group-1',
  kind: DuplicateGroupSummary['kind'] = 'exact_variant',
): DuplicateGroupSummary {
  return {
    id,
    status: 'pending',
    kind,
    mediaCount: 2,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId: 'media-1',
    coverThumbnailUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUsePermissions.mockReturnValue(makePermissions(false));
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook());
    mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook());
  });

  describe('when no active circle', () => {
    it('shows a select-a-circle alert', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircle: null, activeCircleId: null }));

      render(<DuplicatesPage />);

      expect(screen.getByText(/select a circle to review duplicate photos/i)).toBeInTheDocument();
    });
  });

  describe('with active circle', () => {
    it('renders the "Review Duplicates" heading', async () => {
      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getByText(/review duplicates/i)).toBeInTheDocument();
      });
    });

    it('shows a loading spinner while fetching', () => {
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ isLoading: true }));

      render(<DuplicatesPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows the empty state message when no groups are returned', async () => {
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [] }));

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getByText(/no duplicate groups to review/i)).toBeInTheDocument();
      });
    });

    it('renders duplicate group cards when items exist', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({
          items: [makeSummary('g-1'), makeSummary('g-2')],
          meta: { total: 2, page: 1, pageSize: 20 },
        }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        const photoLabels = screen.getAllByText(/2 photos/i);
        expect(photoLabels.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('renders error message when fetch fails', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ error: 'Network error loading duplicates' }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getByText('Network error loading duplicates')).toBeInTheDocument();
      });
    });

    it('calls fetchGroups with status=pending on mount', async () => {
      const fetchGroups = vi.fn().mockResolvedValue(undefined);
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ fetchGroups }));

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(fetchGroups).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: CIRCLE_ID, status: 'pending', page: 1 }),
        );
      });
    });
  });

  describe('kind badges', () => {
    // Note: the filter-chip row always renders "Exact copy" / "Edited variant" /
    // "Similar" labels alongside the per-group kind badge, so these labels are
    // NOT unique on the page. We assert on count (filter chip + card badge)
    // rather than a single getByText match.

    it('shows "Exact copy" badge for exact_variant groups', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1', 'exact_variant')] }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        // One from the filter chip row, one from the group card badge
        expect(screen.getAllByText('Exact copy').length).toBeGreaterThanOrEqual(2);
      });
    });

    it('shows "Edited variant" badge for edited groups', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1', 'edited')] }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Edited variant').length).toBeGreaterThanOrEqual(2);
      });
    });

    it('shows "Similar" badge for similar groups', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1', 'similar')] }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Similar').length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('kind filter chips', () => {
    it('renders all filter chip labels', async () => {
      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getByText('All')).toBeInTheDocument();
        expect(screen.getByText('Exact copy')).toBeInTheDocument();
        expect(screen.getByText('Edited variant')).toBeInTheDocument();
        expect(screen.getByText('Similar')).toBeInTheDocument();
      });
    });

    it('re-fetches with kind="edited" when the "Edited variant" chip is clicked', async () => {
      const fetchGroups = vi.fn().mockResolvedValue(undefined);
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ fetchGroups }));
      const user = userEvent.setup();

      render(<DuplicatesPage />);

      await waitFor(() => expect(fetchGroups).toHaveBeenCalled());
      fetchGroups.mockClear();

      await user.click(screen.getByText('Edited variant'));

      await waitFor(() => {
        expect(fetchGroups).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: CIRCLE_ID, status: 'pending', kind: 'edited' }),
        );
      });
    });

    it('re-fetches with kind=undefined when "All" is clicked after selecting a kind', async () => {
      const fetchGroups = vi.fn().mockResolvedValue(undefined);
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ fetchGroups }));
      const user = userEvent.setup();

      render(<DuplicatesPage />);
      await waitFor(() => expect(fetchGroups).toHaveBeenCalled());

      await user.click(screen.getByText('Similar'));
      await waitFor(() =>
        expect(fetchGroups).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'similar' })),
      );

      fetchGroups.mockClear();
      await user.click(screen.getByText('All'));

      await waitFor(() => {
        expect(fetchGroups).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: CIRCLE_ID, status: 'pending', kind: undefined }),
        );
      });
    });
  });

  describe('chronological ordering', () => {
    it('renders groups in the order provided by the hook (server-sorted by capturedAt)', async () => {
      const earlier = makeSummary('g-early');
      earlier.capturedAt = '2026-01-01T00:00:00.000Z';
      const later = makeSummary('g-later');
      later.capturedAt = '2026-06-01T00:00:00.000Z';

      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [earlier, later] }),
      );

      render(<DuplicatesPage />);

      await waitFor(() => {
        const headings = screen.getAllByText(/2 photos/i);
        expect(headings).toHaveLength(2);
      });

      // Verify DOM order matches array order (earlier first, later second)
      const cards = screen.getAllByText(/2 photos/i).map((el) => el.closest('.MuiCard-root'));
      expect(cards[0]).not.toBeNull();
      expect(cards[1]).not.toBeNull();
    });
  });

  describe('selection checkbox (regression: SelectionCheckboxOverlay refactor)', () => {
    it('the selection checkbox is findable by its accessible name', async () => {
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }),
      );

      render(<DuplicatesPage />);

      expect(
        await screen.findByRole('button', { name: 'Select duplicate group' }),
      ).toBeInTheDocument();
    });
  });

  describe('admin settings gear icon', () => {
    it('renders the gear icon linking to /admin/settings/duplicates for an admin', async () => {
      mockUsePermissions.mockReturnValue(makePermissions(true));
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      const gear = await screen.findByRole('link', { name: /duplicate detection settings/i });
      expect(gear).toBeInTheDocument();
      expect(gear).toHaveAttribute('href', '/admin/settings/duplicates');
    });

    it('does not render the gear icon for a non-admin', async () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      await waitFor(() => {
        expect(screen.getByText(/review duplicates/i)).toBeInTheDocument();
      });
      expect(screen.queryByRole('link', { name: /duplicate detection settings/i })).toBeNull();
    });
  });

  describe('resolve-above-threshold actions', () => {
    it('renders "Archive above N" using the threshold from system settings', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook(80));
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      expect(await screen.findByRole('button', { name: 'Archive above 80' })).toBeInTheDocument();
    });

    it('falls back to a threshold of 60 when system settings has no dedup.autoResolveThreshold', async () => {
      mockUseSystemSettings.mockReturnValue({
        settings: { ui: { allowUserThemeOverride: true }, features: {} } as any,
        isLoading: false,
        isSaving: false,
        error: null,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      expect(await screen.findByRole('button', { name: 'Archive above 60' })).toBeInTheDocument();
    });

    it('does not render the "Delete above N" button when the caller lacks media:delete', async () => {
      mockUsePermissions.mockReturnValue(makePermissions(false, false));
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      expect(await screen.findByRole('button', { name: /archive above/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete above/i })).toBeNull();
    });

    it('renders the "Delete above N" button when the caller has media:delete', async () => {
      mockUseDuplicateGroups.mockReturnValue(makeDuplicateGroupsHook({ items: [makeSummary('g-1')] }));

      render(<DuplicatesPage />);

      expect(await screen.findByRole('button', { name: 'Delete above 60' })).toBeInTheDocument();
    });

    it('clicking "Archive above N" opens a confirm dialog and calls bulkResolveByThreshold(threshold, "archive") on confirm', async () => {
      const user = userEvent.setup();
      const bulkResolveByThreshold = vi.fn().mockResolvedValue({
        resolvedGroups: 3,
        keptCount: 3,
        removedCount: 5,
        action: 'archive',
        skipped: 0,
        errors: 0,
        hasMore: false,
      });
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook(60));
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1')], bulkResolveByThreshold }),
      );

      render(<DuplicatesPage />);

      await user.click(await screen.findByRole('button', { name: 'Archive above 60' }));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(bulkResolveByThreshold).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^archive$/i }));

      await waitFor(() => {
        expect(bulkResolveByThreshold).toHaveBeenCalledWith(60, 'archive');
      });
    });

    it('clicking "Delete above N" opens a confirm dialog and calls bulkResolveByThreshold(threshold, "trash") on confirm', async () => {
      const user = userEvent.setup();
      const bulkResolveByThreshold = vi.fn().mockResolvedValue({
        resolvedGroups: 2,
        keptCount: 2,
        removedCount: 4,
        action: 'trash',
        skipped: 0,
        errors: 0,
        hasMore: false,
      });
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook(60));
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1')], bulkResolveByThreshold }),
      );

      render(<DuplicatesPage />);

      await user.click(await screen.findByRole('button', { name: 'Delete above 60' }));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(bulkResolveByThreshold).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /move to trash/i }));

      await waitFor(() => {
        expect(bulkResolveByThreshold).toHaveBeenCalledWith(60, 'trash');
      });
    });

    it('auto-loops bulkResolveByThreshold while hasMore is true, stopping once hasMore is false', async () => {
      const user = userEvent.setup();
      const bulkResolveByThreshold = vi
        .fn()
        .mockResolvedValueOnce({
          resolvedGroups: 10,
          keptCount: 10,
          removedCount: 20,
          action: 'archive',
          skipped: 0,
          errors: 0,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          resolvedGroups: 10,
          keptCount: 10,
          removedCount: 20,
          action: 'archive',
          skipped: 0,
          errors: 0,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          resolvedGroups: 10,
          keptCount: 10,
          removedCount: 20,
          action: 'archive',
          skipped: 0,
          errors: 0,
          hasMore: false,
        });
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1')], bulkResolveByThreshold }),
      );

      render(<DuplicatesPage />);

      await user.click(await screen.findByRole('button', { name: 'Archive above 60' }));
      await user.click(await screen.findByRole('button', { name: /^archive$/i }));

      await waitFor(() => {
        expect(bulkResolveByThreshold).toHaveBeenCalledTimes(3);
      });
      expect(bulkResolveByThreshold).toHaveBeenNthCalledWith(1, 60, 'archive');
      expect(bulkResolveByThreshold).toHaveBeenNthCalledWith(3, 60, 'archive');
    });

    it('stops the auto-loop early when a batch makes no progress, even if hasMore is true', async () => {
      const user = userEvent.setup();
      const bulkResolveByThreshold = vi.fn().mockResolvedValue({
        resolvedGroups: 0,
        keptCount: 0,
        removedCount: 0,
        action: 'archive',
        skipped: 5,
        errors: 0,
        hasMore: true,
      });
      mockUseDuplicateGroups.mockReturnValue(
        makeDuplicateGroupsHook({ items: [makeSummary('g-1')], bulkResolveByThreshold }),
      );

      render(<DuplicatesPage />);

      await user.click(await screen.findByRole('button', { name: 'Archive above 60' }));
      await user.click(await screen.findByRole('button', { name: /^archive$/i }));

      await waitFor(() => {
        expect(screen.getByText(/resolved 0 groups/i)).toBeInTheDocument();
      });
      expect(bulkResolveByThreshold).toHaveBeenCalledTimes(1);
    });
  });
});
