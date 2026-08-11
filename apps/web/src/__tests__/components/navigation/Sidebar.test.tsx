/**
 * Tests for the Library/Console Sidebar (issue #391, epic #388).
 *
 * Issue #391 folds the six remaining browse rows — Memories, Map, Albums,
 * People, Archive, Trash — into the new Collections destination, and renames
 * "Explore" to "Search" (it always routed to `/search`; a separate
 * explore-style hub lives at `/places`, so the old label was a naming
 * collision, not a feature). Library mode is now exactly FOUR rows: Photos,
 * Collections, Search, Review.
 *
 * None of the folded routes became unreachable — every one of them still
 * resolves and is listed on `/collections` (and, from #392, in the desktop
 * context pane); `navigation/reachability.test.tsx` is the file that proves
 * that at the router level. This file's job is the drawer only: which rows
 * render, and which one lights up as active for a given URL, per the
 * `resolveActiveDestination` model in `config/destinations.ts` (spec §3.5).
 *
 * Console mode, aria-current handling, and the drawer plumbing are unchanged
 * by this issue and are re-asserted here only to prove #391 didn't regress
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
 * Configure `useFeatureFlags` (transitively, through `useReviewQueues`, drives
 * the Review row's aggregate badge) and `useWorkflowsEnabled`.
 *
 * `null` for either boolean means "flag not resolved yet"; a boolean resolves
 * it. `pendingEnhancements` seeds the review-counts response consumed by the
 * Review row's badge total; omit to leave that request permanently in flight.
 *
 * `memories` is still accepted (and still folded into the `features` object
 * `useFeatureFlags` returns) purely because `useReviewQueues` reads the same
 * shared `features` record Sidebar does — but note what it does NOT do since
 * #391: it no longer adds or removes a Sidebar row. Memories moved into
 * Collections; the "renders exactly 4 rows" tests below assert its flag has
 * zero effect on the drawer either way.
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

/** All optional flags resolved ON, for the "4 rows" catalog tests. */
function mockAllFlagsOn(pendingEnhancements = 0) {
  mockFlags({ pictureEnhancement: true, memories: true, workflows: true, pendingEnhancements });
}

// ---------------------------------------------------------------------------
// Shared row-name catalogs
// ---------------------------------------------------------------------------

/** The full 4-row Library catalog (spec §3.1/§3.4) — fixed, never conditional. */
const LIBRARY_ROWS = ['Photos', 'Collections', 'Search', 'Review'];

/**
 * Every row that used to exist in Library mode and must never reappear there:
 * the eight #389 already removed, PLUS the six #391 folded into Collections,
 * PLUS the old "Explore" label #391 renamed to "Search".
 */
const REMOVED_LIBRARY_ROWS = [
  // #389
  'Circles',
  'Notifications',
  'User Settings',
  'Settings',
  'Job Queue',
  'Worker Nodes',
  'Storage Insights',
  'Public Sharing',
  // #391 — folded into Collections
  'Memories',
  'Map',
  'Albums',
  'People',
  'Archive',
  'Trash',
  // #391 — renamed
  'Explore',
];

/**
 * The five UTILITIES rows issue #390 collapsed into the single "Review" row.
 * Their old labels must never reappear as standalone Sidebar rows either.
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
  // Library mode — the 4-row catalog (spec §3.1 / §3.4)
  // =========================================================================

  describe('Library mode', () => {
    it('renders exactly the 4 expected rows, and nothing else, with every flag on', () => {
      setNonAdmin();
      mockAllFlagsOn();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      LIBRARY_ROWS.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });

      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(LIBRARY_ROWS.length);
    });

    it('renders exactly the same 4 rows with every flag off — the row set never changes shape (spec §6.3)', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: false, memories: false, workflows: false });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      LIBRARY_ROWS.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(LIBRARY_ROWS.length);
    });

    it('renders exactly the same 4 rows with every flag unresolved (null)', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: null, memories: null, workflows: null });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      LIBRARY_ROWS.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(LIBRARY_ROWS.length);
    });

    it('never renders any removed row — the eight #389 rows, the six #391-folded browse rows, or the old "Explore" label', () => {
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

    it('never renders a "LIBRARY" subheader — the four-row list has no section heading', () => {
      setNonAdmin();
      mockAllFlagsOn();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(container.querySelector('.MuiListSubheader-root')).toBeNull();
    });

    it('renders the same removed-rows check for an admin viewer too (Library mode ignores role)', () => {
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

    it('"Search" (not "Explore") is the row label, and it navigates to /search', async () => {
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Search')).toBeInTheDocument();
      expect(screen.queryByText('Explore')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Search').closest('.MuiListItemButton-root') as HTMLElement);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/search'));
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
  // Console mode (unchanged by #391 — re-asserted as a non-regression check)
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

    it('does not render any Library-mode row (Photos, Collections, Search, Review)', () => {
      mockLocation.pathname = '/admin/settings/jobs';
      setAdmin(ALL_ADMIN_PERMISSIONS);

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // None of the four Library labels collide with any admin card title
      // (unlike the pre-#391 "Memories" homonym, which no longer applies —
      // Memories is not a Sidebar row anymore, it lives inside Collections).
      LIBRARY_ROWS.forEach((label) => {
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

    it('is set on the Collections row when standing on a route it owns', () => {
      mockLocation.pathname = '/albums';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const collectionsButton = screen
        .getByText('Collections')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(collectionsButton).toHaveAttribute('aria-current', 'page');
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

    it('activates Collections via a genuine segment boundary (e.g. /albums/some-id)', () => {
      mockLocation.pathname = '/albums/some-id';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const collectionsButton = screen
        .getByText('Collections')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(collectionsButton.classList.contains('Mui-selected')).toBe(true);
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
  // The Collections row owns nine route prefixes that don't resemble
  // /collections either — Memories, Map, Albums, People, Archive, Trash, and
  // Tags all folded into it (spec §3.4/§3.5). This is the whole point of
  // #391, so cover several of them explicitly.
  // =========================================================================

  describe('Collections row activation via resolveActiveDestination (spec §3.5)', () => {
    it.each([
      '/collections',
      '/albums',
      '/albums/some-id',
      '/people',
      '/places/countries',
      '/map',
      '/archive',
      '/trash',
      '/tags',
    ])('is the sole active row at %s', (path) => {
      mockLocation.pathname = path;
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const collectionsButton = screen
        .getByText('Collections')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(collectionsButton.classList.contains('Mui-selected')).toBe(true);
      expect(collectionsButton).toHaveAttribute('aria-current', 'page');

      const selected = container.querySelectorAll('.Mui-selected');
      expect(selected).toHaveLength(1);
    });
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
      ['Collections', '/collections'],
      ['Search', '/search'],
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
  // Unaffected by #391.
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
  // Unaffected by #391.
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
  // The memories flag behaviour that still applies (issue #391): the flag
  // still exists and still resolves through the same shared `features`
  // record `useReviewQueues` reads, but it no longer adds a "Memories" row —
  // that moved into Collections (see CollectionsList.test.tsx /
  // CollectionsHubPage.test.tsx for its new home). Pin the negative here so a
  // future contributor cannot "restore" a Memories row keyed off this flag.
  // =========================================================================

  describe('Memories flag has no effect on the Sidebar (moved into Collections by #391)', () => {
    it.each([true, false, null] as const)(
      'never renders a "Memories" row regardless of the memories flag (%s)',
      (memories) => {
        setNonAdmin();
        mockFlags({ memories });

        render(<Sidebar open={true} onClose={mockOnClose} />);

        expect(screen.queryByText('Memories')).not.toBeInTheDocument();
        // The row count never changes shape because of this flag.
        expect(screen.getAllByText(/Photos|Collections|Search|Review/)).toHaveLength(
          LIBRARY_ROWS.length,
        );
      },
    );
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
      expect(icons).toHaveLength(LIBRARY_ROWS.length);
    });
  });
});
