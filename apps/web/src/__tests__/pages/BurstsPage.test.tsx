/**
 * Unit tests for BurstsPage and BurstGroupPage.
 *
 * Covers:
 *  BurstsPage:
 *   - Renders "Review Bursts" heading when a circle is active
 *   - Renders empty state when no groups are returned
 *   - Renders list of burst groups when items exist
 *   - Shows "Scan for bursts" button for collaborator/circle_admin roles
 *   - Shows "Select a circle" alert when no active circle
 *   - Calls runBurstBackfill and shows success snackbar on click
 *
 *  BurstGroupPage:
 *   - Shows loading spinner while fetching
 *   - Renders error state when fetch fails
 *   - Renders all group members
 *   - Pre-selects the suggested best member
 *   - "Keep selected, delete rest" button calls resolve with correct keepIds
 *   - "Not a burst — dismiss" button calls dismiss
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
  runBurstBackfill: vi.fn(),
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
import { runBurstBackfill } from '../../services/bursts';
import type { BurstGroupSummary, BurstGroupDetail } from '../../services/bursts';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseCircle = vi.mocked(useCircle);
const mockUseBurstGroups = vi.mocked(useBurstGroups);
const mockUseBurstGroupDetail = vi.mocked(useBurstGroupDetail);
const mockRunBurstBackfill = vi.mocked(runBurstBackfill);

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
    resolve: vi.fn().mockResolvedValue({ deleted: 2, kept: 1 }),
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
    mockRunBurstBackfill.mockResolvedValue({ enqueued: 5 });
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

  describe('Scan for bursts button', () => {
    it('shows Scan for bursts button for collaborator role', async () => {
      render(<BurstsPage />);

      await waitFor(() => {
        // There may be multiple (header + empty state), but at least one must exist
        const buttons = screen.getAllByRole('button', { name: /scan for bursts/i });
        expect(buttons.length).toBeGreaterThan(0);
      });
    });

    it('shows Scan for bursts button for circle_admin role', async () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'circle_admin' }));

      render(<BurstsPage />);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /scan for bursts/i });
        expect(buttons.length).toBeGreaterThan(0);
      });
    });

    it('calls runBurstBackfill on click and shows success snackbar', async () => {
      const user = userEvent.setup();
      mockRunBurstBackfill.mockResolvedValue({ enqueued: 42 });

      render(<BurstsPage />);

      // The header button is always rendered for collaborator; click the first one
      const btns = await screen.findAllByRole('button', { name: /scan for bursts/i });
      await user.click(btns[0]);

      await waitFor(() => {
        expect(mockRunBurstBackfill).toHaveBeenCalledWith(CIRCLE_ID);
        expect(screen.getByText(/42 items queued/i)).toBeInTheDocument();
      });
    });

    it('shows error alert when runBurstBackfill fails', async () => {
      const user = userEvent.setup();
      mockRunBurstBackfill.mockRejectedValue(new Error('Burst detection not enabled'));

      render(<BurstsPage />);

      const btns = await screen.findAllByRole('button', { name: /scan for bursts/i });
      await user.click(btns[0]);

      await waitFor(() => {
        expect(screen.getByText('Burst detection not enabled')).toBeInTheDocument();
      });
    });

    it('disables button while scan is in progress', async () => {
      const user = userEvent.setup();
      // Never resolves during the test
      mockRunBurstBackfill.mockReturnValue(new Promise(() => {}));

      render(<BurstsPage />);

      const btns = await screen.findAllByRole('button', { name: /scan for bursts/i });
      await user.click(btns[0]);

      await waitFor(() => {
        // There may be multiple scanning buttons (header + empty state both disable)
        const scanningBtns = screen.getAllByRole('button', { name: /scanning/i });
        expect(scanningBtns.length).toBeGreaterThan(0);
        expect(scanningBtns[0]).toBeDisabled();
      });
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
      // media-1 is the suggested best; we verify the "Keep N, delete M" button
      // reflects that exactly 1 item is pre-selected
      render(<BurstGroupPage />);

      await waitFor(() => {
        // With 1 selected (suggested best) and 3 total, button should say "Keep 1, delete 2 others"
        expect(screen.getByRole('button', { name: /keep 1.*delete 2/i })).toBeInTheDocument();
      });
    });
  });

  describe('resolve action', () => {
    it('opens confirm dialog when Keep button is clicked', async () => {
      const user = userEvent.setup();

      render(<BurstGroupPage />);

      const keepBtn = await screen.findByRole('button', { name: /keep 1.*delete 2/i });
      await user.click(keepBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/confirm deletion/i)).toBeInTheDocument();
      });
    });

    it('calls resolve with keepIds after confirm dialog', async () => {
      const user = userEvent.setup();
      const mockResolve = vi.fn().mockResolvedValue({ deleted: 2, kept: 1 });
      mockUseBurstGroupDetail.mockReturnValue(
        makeBurstGroupDetailHook({ resolve: mockResolve }),
      );

      render(<BurstGroupPage />);

      const keepBtn = await screen.findByRole('button', { name: /keep 1.*delete 2/i });
      await user.click(keepBtn);

      // Confirm in dialog
      const deleteBtn = await screen.findByRole('button', { name: /delete 2 photo/i });
      await user.click(deleteBtn);

      await waitFor(() => {
        expect(mockResolve).toHaveBeenCalledWith(expect.arrayContaining(['media-1']));
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
