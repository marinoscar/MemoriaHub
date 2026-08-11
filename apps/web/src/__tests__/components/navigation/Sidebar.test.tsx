/**
 * Tests for the Library/Console Sidebar (issue #390, epic #388).
 *
 * Issue #390 collapses the five UTILITIES rows (Bursts, Duplicates, Location
 * Suggestions, AI Enhancements, Workflows / Review Insights) into ONE badged
 * "Review" row (spec §3.3 / §6.2 / §6.3). Library mode is now nine rows:
 * Photos, Memories, Explore, Map, Albums, People, Archive, Trash, Review.
 *
 * Console mode, aria-current handling, and the drawer plumbing are unchanged
 * by this issue and are re-asserted here only to prove #390 didn't regress
 * them, not because their logic moved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { Sidebar } from '../../../components/navigation/Sidebar';
import { visibleAdminSections } from '../../../config/adminSections';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
const mockLocation = { pathname: '/' };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation,
  };
});

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../hooks/useWorkflowSubjects', () => ({
  useWorkflowsEnabled: vi.fn(),
}));

// The Review row's aggregate badge is the sole consumer of
// GET /api/media/review-counts (via useReviewQueues -> useReviewCounts), and
// it only fires while at least one counted queue feature is on (issue #204,
// broadened by #390) — partial-mock the media service so these tests can
// assert a request was (or was not) actually issued, not just what rendered.
vi.mock('../../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/media')>()),
  getReviewCounts: vi.fn(),
  getDashboard: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { useWorkflowsEnabled } from '../../../hooks/useWorkflowSubjects';
import { getReviewCounts, getDashboard } from '../../../services/media';

const mockGetReviewCounts = vi.mocked(getReviewCounts);
const mockGetDashboard = vi.mocked(getDashboard);

// ---------------------------------------------------------------------------
// Permission mock helpers
// ---------------------------------------------------------------------------

function permissionsMock(overrides: {
  isAdmin?: boolean;
  permissions?: string[];
  hasPermission?: (perm: string) => boolean;
} = {}) {
  const { isAdmin = false, permissions = [], hasPermission } = overrides;
  return {
    permissions: new Set(permissions),
    roles: new Set(isAdmin ? ['admin'] : []),
    hasPermission: hasPermission ?? ((perm: string) => permissions.includes(perm)),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin,
  };
}

function setNonAdmin() {
  vi.mocked(usePermissions).mockReturnValue(permissionsMock());
}

function setAdmin(permissions: string[] = []) {
  vi.mocked(usePermissions).mockReturnValue(permissionsMock({ isAdmin: true, permissions }));
}

/** Every permission any admin card in the catalog is gated behind. */
const ALL_ADMIN_PERMISSIONS = Array.from(
  new Set(
    visibleAdminSections(() => true)
      .flatMap((s) => s.cards)
      .map((c) => c.permission)
      .filter((p): p is string => Boolean(p)),
  ),
);

// ---------------------------------------------------------------------------
// Feature-flag mock helpers
// ---------------------------------------------------------------------------

/**
 * Configure `useFeatureFlags` (drives the Memories row and, transitively
 * through `useReviewQueues`, the Review row's aggregate badge) and
 * `useWorkflowsEnabled`.
 *
 * `null` for either boolean means "flag not resolved yet" (hidden); a
 * boolean resolves it. `pendingEnhancements` seeds the review-counts response
 * consumed by the Review row's badge total; omit to leave that request
 * permanently in flight.
 */
function mockFlags(options: {
  pictureEnhancement?: boolean | null;
  memories?: boolean | null;
  workflows?: boolean | null;
  pendingEnhancements?: number;
} = {}) {
  const { pictureEnhancement = null, memories = null, workflows = null, pendingEnhancements } = options;

  const features: Record<string, boolean> | null =
    pictureEnhancement === null && memories === null
      ? null
      : {
          ...(pictureEnhancement !== null ? { pictureEnhancement } : {}),
          ...(memories !== null ? { memories } : {}),
        };

  vi.mocked(useFeatureFlags).mockReturnValue({
    features,
    pictureEnhancement:
      pictureEnhancement === null
        ? null
        : {
            enabled: pictureEnhancement,
            allowReplace: true,
            blockReplaceOnDownscale: false,
            model: 'gpt-image-1',
          },
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });

  vi.mocked(useWorkflowsEnabled).mockReturnValue(workflows);

  if (pictureEnhancement === true) {
    if (pendingEnhancements === undefined) {
      mockGetReviewCounts.mockReturnValue(new Promise(() => {}));
    } else {
      mockGetReviewCounts.mockResolvedValue({
        pendingBurstGroups: 0,
        pendingDuplicateGroups: 0,
        pendingLocationSuggestions: 0,
        pendingEnhancements,
      });
    }
  }
}

/** All three optional flags resolved ON, for the "9 rows" catalog test. */
function mockAllFlagsOn(pendingEnhancements = 0) {
  mockFlags({ pictureEnhancement: true, memories: true, workflows: true, pendingEnhancements });
}

// ---------------------------------------------------------------------------
// Shared row-name catalogs
// ---------------------------------------------------------------------------

/** The full 9-row Library catalog when every optional flag is enabled. */
const LIBRARY_ALL_FLAGS_ROWS = [
  'Photos',
  'Memories',
  'Explore',
  'Map',
  'Albums',
  'People',
  'Archive',
  'Trash',
  'Review',
];

/** Rows that used to exist and must never reappear in Library mode. */
const REMOVED_LIBRARY_ROWS = [
  'Circles',
  'Notifications',
  'User Settings',
  'Settings',
  'Job Queue',
  'Worker Nodes',
  'Storage Insights',
  'Public Sharing',
];

/**
 * The five UTILITIES rows issue #390 collapsed into the single "Review" row.
 * Their old labels (from the pre-#390 drawer) must never reappear as
 * standalone Sidebar rows in Library mode.
 */
const REMOVED_UTILITIES_ROWS = [
  'Review Bursts',
  'Review Duplicates',
  'Review Insights',
  'Location Suggestions',
  'Workflows',
  'AI Enhancements',
];

describe('Sidebar', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.pathname = '/';
    mockFlags();
  });

  // =========================================================================
  // Library mode — the 9-row catalog
  // =========================================================================

  describe('Library mode', () => {
    it('renders exactly the 9 expected rows with every flag on, and nothing else', () => {
      setNonAdmin();
      mockAllFlagsOn();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      LIBRARY_ALL_FLAGS_ROWS.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });

      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(LIBRARY_ALL_FLAGS_ROWS.length);
    });

    it('never renders Circles, Notifications, User Settings, Settings, Job Queue, Worker Nodes, Storage Insights, or Public Sharing', () => {
      setNonAdmin();
      mockAllFlagsOn();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      REMOVED_LIBRARY_ROWS.forEach((label) => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });
    });

    it('never renders the old UTILITIES rows (Bursts, Duplicates, Location Suggestions, Workflows, AI Enhancements) or a "Utilities" heading — they collapsed into the single Review row', () => {
      setNonAdmin();
      mockAllFlagsOn();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      REMOVED_UTILITIES_ROWS.forEach((label) => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });
      expect(screen.queryByText('Utilities')).not.toBeInTheDocument();
    });

    it('renders the same removed rows check for an admin viewer too (Library mode ignores role)', () => {
      setAdmin(ALL_ADMIN_PERMISSIONS);
      mockAllFlagsOn();

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // "Settings" itself is never a Library row; the mode-switch affordance
      // is a distinct "Console" label (asserted separately below).
      REMOVED_LIBRARY_ROWS.forEach((label) => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });
      expect(screen.getByText('Console')).toBeInTheDocument();
    });

    it('drops Memories when its flag is off/unresolved, but keeps the other 8 rows', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: false, memories: false, workflows: false });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('Memories')).not.toBeInTheDocument();

      ['Photos', 'Explore', 'Map', 'Albums', 'People', 'Archive', 'Trash', 'Review'].forEach(
        (label) => {
          expect(screen.getByText(label)).toBeInTheDocument();
        },
      );
    });

    // =======================================================================
    // The Review row is unconditional (spec §6.3) — "do not regress" rules
    // =======================================================================

    describe('Review row — unconditional rendering (spec §6.3)', () => {
      it('renders even when every review feature (bursts/duplicates/locations/enhancements/workflows) is off', () => {
        setNonAdmin();
        mockFlags({ pictureEnhancement: false, memories: false, workflows: false });

        render(<Sidebar open={true} onClose={mockOnClose} />);

        expect(screen.getByText('Review')).toBeInTheDocument();
      });

      it('renders even when every review feature is unresolved (null)', () => {
        setNonAdmin();
        mockFlags({ pictureEnhancement: null, memories: null, workflows: null });

        render(<Sidebar open={true} onClose={mockOnClose} />);

        expect(screen.getByText('Review')).toBeInTheDocument();
      });

      it('renders even when the aggregate pending count is zero', async () => {
        setNonAdmin();
        mockFlags({ pictureEnhancement: true, pendingEnhancements: 0 });

        render(<Sidebar open={true} onClose={mockOnClose} />);

        await waitFor(() => expect(mockGetReviewCounts).toHaveBeenCalled());
        expect(screen.getByText('Review')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Console mode (unchanged by #390 — re-asserted as a non-regression check)
  // =========================================================================

  describe('Console mode', () => {
    it('renders the admin section labels and card titles, and "Back to library", when granted every permission', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText('Back to library')).toBeInTheDocument();

      const fullCatalog = visibleAdminSections(() => true);
      fullCatalog.forEach((section) => {
        expect(screen.getByText(section.label)).toBeInTheDocument();
        section.cards.forEach((card) => {
          expect(screen.getByText(card.title)).toBeInTheDocument();
        });
      });
    });

    it('does not render any Library-mode row (Photos, Albums, People, ...)', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // "Memories" is excluded from this check: it is ALSO a genuine admin
      // card title (AI & Enrichment > Memories, the digest/generation
      // settings page) — its presence here is expected, not a leak of the
      // Library nav row. Every other Library row has no admin-card homonym.
      LIBRARY_ALL_FLAGS_ROWS.filter((label) => label !== 'Memories').forEach((label) => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });
    });

    it('never renders the Console mode-switch affordance while already in Console mode', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Only ONE "Console" appearance is expected anywhere: there is none —
      // the way out is "Back to library", not a second Console button.
      expect(screen.queryByText('Console')).not.toBeInTheDocument();
    });

    it('respects per-card permission gates: lacking jobs:read hides Job Queue (and Job Queue Insights, Worker Nodes)', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(['system_settings:read']); // no jobs:read

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.queryByText('Job Queue')).not.toBeInTheDocument();
      expect(screen.queryByText('Job Queue Insights')).not.toBeInTheDocument();
      expect(screen.queryByText('Worker Nodes')).not.toBeInTheDocument();
      // A card gated on a DIFFERENT, granted permission still renders.
      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('renders Job Queue once jobs:read is granted, and navigates to it on click', async () => {
      mockLocation.pathname = '/admin/settings';
      setAdmin(['jobs:read']);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const button = screen.getByText('Job Queue').closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/jobs');
      });
    });

    it('a non-admin never sees the Console affordance in Library mode', () => {
      mockLocation.pathname = '/';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('Console')).not.toBeInTheDocument();
    });

    it('renders the Console affordance at the foot of Library mode for an admin, and it navigates to /admin/settings', async () => {
      mockLocation.pathname = '/';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const consoleButton = screen.getByText('Console').closest('.MuiListItemButton-root') as HTMLElement;

      // Pinned at the very foot: the last button in the drawer.
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons[buttons.length - 1]).toBe(consoleButton);

      fireEvent.click(consoleButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings');
      });
    });

    it('"Back to library" navigates to /', async () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const backButton = screen.getByText('Back to library').closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(backButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/');
      });
    });
  });

  // =========================================================================
  // aria-current="page"
  // =========================================================================

  describe('aria-current="page"', () => {
    it('is set on the active row in Library mode and on no other row', () => {
      mockLocation.pathname = '/';
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const photosButton = screen.getByText('Photos').closest('.MuiListItemButton-root') as HTMLElement;
      expect(photosButton).toHaveAttribute('aria-current', 'page');

      const others = Array.from(container.querySelectorAll('.MuiListItemButton-root')).filter(
        (el) => el !== photosButton,
      );
      others.forEach((el) => expect(el).not.toHaveAttribute('aria-current'));
    });

    it('is set on the active row in Console mode', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(['jobs:read']);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const jobQueueButton = screen.getByText('Job Queue').closest('.MuiListItemButton-root') as HTMLElement;
      expect(jobQueueButton).toHaveAttribute('aria-current', 'page');
    });

    it('longest-prefix-wins: at /admin/settings/jobs/insights, aria-current lands on "Job Queue Insights" and NOT on "Job Queue"', () => {
      mockLocation.pathname = '/admin/settings/jobs/insights';
      setAdmin(['jobs:read']);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const jobQueueButton = screen.getByText('Job Queue').closest('.MuiListItemButton-root') as HTMLElement;
      const insightsButton = screen
        .getByText('Job Queue Insights')
        .closest('.MuiListItemButton-root') as HTMLElement;

      expect(insightsButton).toHaveAttribute('aria-current', 'page');
      expect(jobQueueButton).not.toHaveAttribute('aria-current');
      // `selected` (the MUI visual state) must agree with aria-current.
      expect(insightsButton.classList.contains('Mui-selected')).toBe(true);
      expect(jobQueueButton.classList.contains('Mui-selected')).toBe(false);
    });

    it('is set on the Review row when standing on one of the routes it owns', () => {
      mockLocation.pathname = '/bursts';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
      expect(reviewButton).toHaveAttribute('aria-current', 'page');
    });
  });

  // =========================================================================
  // Segment-boundary matching (spec §3.5)
  // =========================================================================

  describe('segment-boundary matching', () => {
    it('activates no row at /reviewer (must not fuzzy-match the Review row)', () => {
      mockLocation.pathname = '/reviewer';
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const selected = container.querySelectorAll('.Mui-selected');
      expect(selected).toHaveLength(0);
    });

    it('does not activate Review at /burstsfoo', () => {
      mockLocation.pathname = '/burstsfoo';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
      expect(reviewButton.classList.contains('Mui-selected')).toBe(false);
    });

    it('activates Photos ONLY on an exact match at /', () => {
      mockLocation.pathname = '/';
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const photosButton = screen.getByText('Photos').closest('.MuiListItemButton-root') as HTMLElement;
      expect(photosButton.classList.contains('Mui-selected')).toBe(true);

      const selected = container.querySelectorAll('.Mui-selected');
      expect(selected).toHaveLength(1);
    });

    it('activates Review via a genuine segment boundary (e.g. /bursts/some-id)', () => {
      mockLocation.pathname = '/bursts/some-id';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
      expect(reviewButton.classList.contains('Mui-selected')).toBe(true);
    });
  });

  // =========================================================================
  // The Review row owns nine route prefixes that don't resemble /review
  // (spec §3.5) — a path-prefix match on the item's own path cannot express
  // this, so it is driven by `resolveActiveDestination` instead. This is the
  // whole point of the destination model, so cover several non-/review paths.
  // =========================================================================

  describe('Review row activation via resolveActiveDestination (spec §3.5)', () => {
    it.each(['/review', '/bursts', '/bursts/some-id', '/workflows', '/review-insights'])(
      'is the sole active row at %s',
      (path) => {
        mockLocation.pathname = path;
        setNonAdmin();

        const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

        const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
        expect(reviewButton.classList.contains('Mui-selected')).toBe(true);
        expect(reviewButton).toHaveAttribute('aria-current', 'page');

        const selected = container.querySelectorAll('.Mui-selected');
        expect(selected).toHaveLength(1);
      },
    );
  });

  // =========================================================================
  // Drawer plumbing — unchanged by this issue, still load-bearing
  // =========================================================================

  describe('Drawer plumbing', () => {
    it('renders the Drawer JSX even when open is false (never returns null)', () => {
      setNonAdmin();
      expect(() => render(<Sidebar open={false} onClose={mockOnClose} />)).not.toThrow();
    });

    it('renders the Drawer when open is true', () => {
      setNonAdmin();
      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(container.querySelector('.MuiDrawer-root')).not.toBeNull();
    });

    it('calls onClose BEFORE navigate on a row click', async () => {
      setNonAdmin();
      const callOrder: string[] = [];
      const trackingOnClose = vi.fn(() => callOrder.push('onClose'));
      mockNavigate.mockImplementation(() => callOrder.push('navigate'));

      render(<Sidebar open={true} onClose={trackingOnClose} />);

      fireEvent.click(screen.getByText('Photos').closest('.MuiListItemButton-root') as HTMLElement);

      expect(trackingOnClose).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      expect(callOrder).toEqual(['onClose', 'navigate']);
    });
  });

  // =========================================================================
  // Navigation targets for every Library row
  // =========================================================================

  describe('Navigation targets', () => {
    it.each([
      ['Photos', '/'],
      ['Explore', '/search'],
      ['Map', '/map'],
      ['Albums', '/albums'],
      ['People', '/people'],
      ['Archive', '/archive'],
      ['Trash', '/trash'],
      ['Review', '/review'],
    ])('navigates to %s -> %s', async (label, path) => {
      setNonAdmin();
      render(<Sidebar open={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByText(label).closest('.MuiListItemButton-root') as HTMLElement);

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(path));
    });
  });

  // =========================================================================
  // Review row badge (issue #201/#204 precedent, re-pointed by #390 —
  // the badge is no longer a distinct "AI Enhancements" row; it is the
  // Review row's aggregate total, exercised here through the single
  // pictureEnhancement flag for a deterministic, single-source count).
  // =========================================================================

  describe('Review row badge', () => {
    it('renders the pending count as a badge and in the accessible name', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 7 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('7');
      });

      const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
      expect(reviewButton).toHaveAttribute('aria-label', 'Review, 7 items pending');
    });

    it('caps the visible badge at 999+ (the underlying count is unrounded elsewhere)', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 1500 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('999+');
      });
    });

    it('renders no badge when the pending count is zero, and the accessible name carries no count phrase', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 0 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => expect(mockGetReviewCounts).toHaveBeenCalled());
      expect(container.querySelector('.MuiBadge-badge')).toBeNull();

      const reviewButton = screen.getByText('Review').closest('.MuiListItemButton-root') as HTMLElement;
      expect(reviewButton).toHaveAttribute('aria-label', 'Review');
    });
  });

  // =========================================================================
  // Review-counts request gating (issue #204, broadened by #390 to "any
  // review feature enabled", re-pointed at the Review row's own wiring).
  // =========================================================================

  describe('Review-counts request gating', () => {
    it('issues no request while every review feature is unresolved or off', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: null });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.getByText('Photos')).toBeInTheDocument();
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('requests counts for the active circle once a review feature is enabled, and never calls the full dashboard', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 3 });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-1');
      });
      expect(mockGetDashboard).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Memories entry (issue #309, preserved — unaffected by #390)
  // =========================================================================

  describe('Memories entry', () => {
    it('is hidden when the flag is off', () => {
      setNonAdmin();
      mockFlags({ memories: false });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.queryByText('Memories')).not.toBeInTheDocument();
    });

    it('is hidden while the flag is unresolved', () => {
      setNonAdmin();
      mockFlags({ memories: null });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.queryByText('Memories')).not.toBeInTheDocument();
    });

    it('appears in the primary section and navigates to /memories when enabled', async () => {
      setNonAdmin();
      mockFlags({ memories: true });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Memories')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Memories'));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/memories'));
    });
  });

  // =========================================================================
  // Accessibility
  // =========================================================================

  describe('Accessibility', () => {
    it('is keyboard navigable — Enter on a focused row triggers navigation', async () => {
      const user = userEvent.setup();
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const photosButton = container.querySelector('.MuiListItemButton-root') as HTMLElement;
      photosButton.focus();
      expect(photosButton).toHaveFocus();

      await user.keyboard('{Enter}');
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    });

    it('every row carries an icon', () => {
      setNonAdmin();
      mockAllFlagsOn();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const icons = container.querySelectorAll('.MuiListItemIcon-root');
      expect(icons).toHaveLength(LIBRARY_ALL_FLAGS_ROWS.length);
    });
  });
});
