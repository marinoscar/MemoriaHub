/**
 * Unit tests for BurstsPage and BurstGroupPage.
 *
 * Covers:
 *  BurstsPage:
 *   - Renders "Review Bursts" heading when a circle is active
 *   - Renders empty state when no groups are returned
 *   - Renders list of burst groups when items exist
 *   - Shows "Select a circle" alert when no active circle
 *   - Uses meta.total (not items.length) for the summary line and pagination
 *   - Bulk-resolve toolbar: selecting groups surfaces the toolbar, "Resolve &
 *     Archive" calls bulkResolve(ids, 'archive') directly, "Resolve & Delete"
 *     confirms before calling bulkResolve(ids, 'trash')
 *
 *  BurstGroupPage:
 *   - Shows loading spinner while fetching
 *   - Renders error state when fetch fails
 *   - Renders all group members
 *   - Pre-selects the suggested best member
 *   - Default action is "archive"; the archive/trash ToggleButtonGroup drives
 *     which action resolve() is called with
 *   - "Not a burst — dismiss" button calls dismiss
 *
 * Note: The "Scan for bursts" per-circle backfill button was removed in the
 * settings refactor. Burst detection is now a global setting managed from
 * the admin settings hub (/admin/settings/bursts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/useBursts', () => ({
  useBurstGroups: vi.fn(),
  useBurstGroupDetail: vi.fn(),
}));

vi.mock('../../services/bursts', () => ({
  listBurstGroups: vi.fn(),
  getBurstGroup: vi.fn(),
  resolveBurstGroup: vi.fn(),
  dismissBurstGroup: vi.fn(),
}));

// react-router-dom navigate mock
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ id: 'group-test-id' }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import BurstsPage from '../../pages/Bursts/BurstsPage';
import BurstGroupPage from '../../pages/Bursts/BurstGroupPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircle } from '../../hooks/useCircle';
import { useBurstGroups, useBurstGroupDetail } from '../../hooks/useBursts';
import type { BurstGroupSummary, BurstGroupDetail } from '../../services/bursts';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseCircle = vi.mocked(useCircle);
const mockUseBurstGroups = vi.mocked(useBurstGroups);
const mockUseBurstGroupDetail = vi.mocked(useBurstGroupDetail);

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

function makePermissions(isAdmin = false, role: string | null = 'collaborator') {
  return {
    permissions: new Set<string>(['media:read', 'media:write', 'media:delete']),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
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

function makeBurstGroupsHook(overrides: Partial<ReturnType<typeof useBurstGroups>> = {}): ReturnType<typeof useBurstGroups> {
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
      errors: [],
    }),
    ...overrides,
  };
}

function makeSummary(id = 'group-1'): BurstGroupSummary {
  return {
    id,
    circleId: CIRCLE_ID,
    status: 'pending',
    mediaCount: 5,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId: 'media-1',
    suggestedBestThumbnailUrl: 'https://cdn.example.com/best.jpg',
    coverThumbnailUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
    createdAt: '2026-06-15T14:32:10.000Z',
  };
}

function makeMember(id: string, isSuggestedBest = false) {
  return {
    id,
    capturedAt: '2026-06-15T14:32:00.000Z',
    burstScore: isSuggestedBest ? 0.87 : 0.42,
    sharpnessScore: isSuggestedBest ? 412.3 : 210.1,
    thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
    width: 4032,
    height: 3024,
    isSuggestedBest,
  };
}

function makeGroupDetail(suggestedBestItemId = 'media-1'): BurstGroupDetail {
  return {
    id: 'group-test-id',
    circleId: CIRCLE_ID,
    status: 'pending',
    mediaCount: 3,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId,
    resolvedById: null,
    resolvedAt: null,
    members: [
      makeMember('media-1', suggestedBestItemId === 'media-1'),
      makeMember('media-2', suggestedBestItemId === 'media-2'),
      makeMember('media-3', suggestedBestItemId === 'media-3'),
    ],
  };
}

function makeBurstGroupDetailHook(
  overrides: Partial<ReturnType<typeof useBurstGroupDetail>> = {},
): ReturnType<typeof useBurstGroupDetail> {
  return {
    group: makeGroupDetail(),
    isLoading: false,
    error: null,
    fetchGroup: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ removed: 2, kept: 1, action: 'archive', groupStatus: 'resolved' }),
    dismiss: vi.fn().mockResolvedValue(undefined),
    resolving: false,
    dismissing: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BurstsPage tests
// ---------------------------------------------------------------------------

describe('BurstsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions(false));
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseBurstGroups.mockReturnValue(makeBurstGroupsHook());
  });

  describe('when no active circle', () => {
    it('shows select-a-circle alert', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircle: null, activeCircleId: null }));

      render(<BurstsPage />);

      expect(screen.getByText(/select a circle to review burst groups/i)).toBeInTheDocument();
    });
  });

  describe('with active circle', () => {
    it('renders the "Review Bursts" heading', async () => {
      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText(/review bursts/i)).toBeInTheDocument();
      });
    });

    it('shows loading spinner while fetching', () => {
      mockUseBurstGroups.mockReturnValue(makeBurstGroupsHook({ isLoading: true }));

      render(<BurstsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows empty state message when no groups returned', async () => {
      mockUseBurstGroups.mockReturnValue(makeBurstGroupsHook({ items: [] }));

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText(/no burst groups to review/i)).toBeInTheDocument();
      });
    });

    it('renders burst group cards when items exist', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ items: [makeSummary('g-1'), makeSummary('g-2')] }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        // Two groups each showing "5 photos"
        const photoLabels = screen.getAllByText(/5 photos/i);
        expect(photoLabels.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('renders error message when fetch fails', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ error: 'Network error loading bursts' }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText('Network error loading bursts')).toBeInTheDocument();
      });
    });
  });

  describe('meta.total-driven summary and pagination', () => {
    it('uses meta.total (not items.length) in the summary line', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({
          items: [makeSummary('g-1'), makeSummary('g-2')],
          meta: { total: 42, page: 1, pageSize: 20 },
        }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText(/42 burst groups pending review/i)).toBeInTheDocument();
      });
    });

    it('falls back to items.length when meta is null', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ items: [makeSummary('g-1')], meta: null }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText(/1 burst group pending review/i)).toBeInTheDocument();
      });
    });

    it('renders Pagination controls when meta implies more than one page', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({
          items: [makeSummary('g-1')],
          meta: { total: 3, page: 1, pageSize: 1 },
        }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /go to page 2/i })).toBeInTheDocument();
      });
    });

    it('does not render Pagination controls when everything fits on one page', async () => {
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({
          items: [makeSummary('g-1')],
          meta: { total: 1, page: 1, pageSize: 20 },
        }),
      );

      render(<BurstsPage />);

      await waitFor(() => {
        expect(screen.getByText(/1 burst group pending review/i)).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /go to page 2/i })).toBeNull();
    });
  });

  describe('bulk-resolve toolbar', () => {
    it('shows the toolbar with a selection count once a group is selected', async () => {
      const user = userEvent.setup();
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ items: [makeSummary('g-1'), makeSummary('g-2')] }),
      );

      render(<BurstsPage />);

      // Note: the group-selection Checkbox uses the legacy MUI `inputProps`
      // prop for its aria-label, which this MUI version no longer forwards to
      // the native <input> (see the reported product bug in the test report).
      // Select by role instead of accessible name until that's fixed.
      const checkboxes = await screen.findAllByRole('checkbox');
      await user.click(checkboxes[0]);

      await waitFor(() => {
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      });
    });

    it('"Resolve & Archive" calls bulkResolve with the selected ids and action=archive', async () => {
      const user = userEvent.setup();
      const bulkResolve = vi.fn().mockResolvedValue({
        resolvedGroups: 1,
        keptCount: 1,
        removedCount: 2,
        action: 'archive',
        skipped: 0,
        errors: [],
      });
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ items: [makeSummary('g-1')], bulkResolve }),
      );

      render(<BurstsPage />);

      const checkbox = await screen.findByRole('checkbox');
      await user.click(checkbox);
      await user.click(await screen.findByRole('button', { name: /resolve.*archive/i }));

      await waitFor(() => {
        expect(bulkResolve).toHaveBeenCalledWith(['g-1'], 'archive');
      });
    });

    it('"Resolve & Delete" opens a confirm dialog and calls bulkResolve with action=trash after confirming', async () => {
      const user = userEvent.setup();
      const bulkResolve = vi.fn().mockResolvedValue({
        resolvedGroups: 1,
        keptCount: 1,
        removedCount: 2,
        action: 'trash',
        skipped: 0,
        errors: [],
      });
      mockUseBurstGroups.mockReturnValue(
        makeBurstGroupsHook({ items: [makeSummary('g-1')], bulkResolve }),
      );

      render(<BurstsPage />);

      const checkbox = await screen.findByRole('checkbox');
      await user.click(checkbox);
      await user.click(await screen.findByRole('button', { name: /resolve.*delete/i }));

      // Trash always requires confirmation, even for a single-item selection.
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(bulkResolve).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /move to trash/i }));

      await waitFor(() => {
        expect(bulkResolve).toHaveBeenCalledWith(['g-1'], 'trash');
      });
    });

    it('hides the "Resolve & Delete" action when the caller lacks media:delete', async () => {
      const user = userEvent.setup();
      // Override hasPermission to deny media:delete specifically.
      const perms = makePermissions(false, 'collaborator');
      perms.hasPermission = vi.fn().mockReturnValue(false);
      mockUsePermissions.mockReturnValue(perms);

      mockUseBurstGroups.mockReturnValue(makeBurstGroupsHook({ items: [makeSummary('g-1')] }));

      render(<BurstsPage />);

      const checkbox = await screen.findByRole('checkbox');
      await user.click(checkbox);

      await waitFor(() => {
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /resolve.*delete/i })).toBeNull();
      expect(screen.getByRole('button', { name: /resolve.*archive/i })).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// BurstGroupPage tests
// ---------------------------------------------------------------------------

describe('BurstGroupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions(false));
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseBurstGroupDetail.mockReturnValue(makeBurstGroupDetailHook());
  });

  describe('loading and error states', () => {
    it('shows loading spinner while fetching', () => {
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ group: null, isLoading: true }),
      );

      render(<BurstGroupPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows error message when fetch fails', async () => {
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ group: null, error: 'Group not found', isLoading: false }),
      );

      render(<BurstGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Group not found')).toBeInTheDocument();
      });
    });
  });

  describe('rendering group members', () => {
    it('renders all group members', async () => {
      render(<BurstGroupPage />);

      await waitFor(() => {
        // Default group has 3 members; all should have quality bars rendered
        const progressBars = screen.getAllByRole('progressbar');
        // Each member gets a LinearProgress quality bar
        expect(progressBars.length).toBeGreaterThanOrEqual(3);
      });
    });

    it('shows "Best pick" chip on the suggested best member', async () => {
      render(<BurstGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Best pick')).toBeInTheDocument();
      });
    });

    it('shows "Burst Group" heading', async () => {
      render(<BurstGroupPage />);

      await waitFor(() => {
        expect(screen.getByText(/burst group/i)).toBeInTheDocument();
      });
    });
  });

  describe('pre-selection of suggested best', () => {
    it('pre-selects the suggested best member checkbox', async () => {
      // media-1 is the suggested best; we verify the "Keep N, <action> M" button
      // reflects that exactly 1 item is pre-selected. The default action is
      // "archive" (the ToggleButtonGroup default), so the label reads
      // "Keep 1, archive 2 others".
      render(<BurstGroupPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /keep 1.*archive 2/i })).toBeInTheDocument();
      });
    });
  });

  describe('resolve action', () => {
    it('opens confirm dialog when Keep button is clicked (default action: archive)', async () => {
      const user = userEvent.setup();

      render(<BurstGroupPage />);

      const keepBtn = await screen.findByRole('button', { name: /keep 1.*archive 2/i });
      await user.click(keepBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/confirm archive/i)).toBeInTheDocument();
      });
    });

    it('calls resolve with keepIds and action="archive" after confirming the default action', async () => {
      const user = userEvent.setup();
      const mockResolve = vi.fn().mockResolvedValue({
        removed: 2,
        kept: 1,
        action: 'archive',
        groupStatus: 'resolved',
      });
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ resolve: mockResolve }),
      );

      render(<BurstGroupPage />);

      const keepBtn = await screen.findByRole('button', { name: /keep 1.*archive 2/i });
      await user.click(keepBtn);

      // Confirm in dialog — default action is archive
      const archiveBtn = await screen.findByRole('button', { name: /^archive 2 photo/i });
      await user.click(archiveBtn);

      await waitFor(() => {
        expect(mockResolve).toHaveBeenCalledWith(expect.arrayContaining(['media-1']), 'archive');
      });
    });

    it('switching the toggle to "Trash" changes the button label and calls resolve with action="trash"', async () => {
      const user = userEvent.setup();
      const mockResolve = vi.fn().mockResolvedValue({
        removed: 2,
        kept: 1,
        action: 'trash',
        groupStatus: 'resolved',
      });
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ resolve: mockResolve }),
      );

      render(<BurstGroupPage />);

      await user.click(await screen.findByRole('button', { name: /^trash$/i }));

      const keepBtn = await screen.findByRole('button', { name: /keep 1.*trash 2/i });
      await user.click(keepBtn);

      const trashBtn = await screen.findByRole('button', { name: /move to trash 2 photo/i });
      await user.click(trashBtn);

      await waitFor(() => {
        expect(mockResolve).toHaveBeenCalledWith(expect.arrayContaining(['media-1']), 'trash');
      });
    });
  });

  describe('dismiss action', () => {
    it('opens dismiss confirm dialog when "Not a burst" button is clicked', async () => {
      const user = userEvent.setup();

      render(<BurstGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not a burst/i });
      await user.click(dismissBtn);

      await waitFor(() => {
        expect(screen.getByText(/dismiss burst group/i)).toBeInTheDocument();
      });
    });

    it('calls dismiss after confirm', async () => {
      const user = userEvent.setup();
      const mockDismiss = vi.fn().mockResolvedValue(undefined);
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ dismiss: mockDismiss }),
      );

      render(<BurstGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not a burst/i });
      await user.click(dismissBtn);

      const confirmBtn = await screen.findByRole('button', { name: /^dismiss$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockDismiss).toHaveBeenCalledTimes(1);
      });
    });
  });
});
