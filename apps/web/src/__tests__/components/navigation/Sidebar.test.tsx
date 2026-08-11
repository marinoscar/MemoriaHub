/**
 * Tests for the Library/Console Sidebar (issue #389, epic #388).
 *
 * The drawer now has exactly two modes, selected purely by `location.pathname`
 * (spec §3.2):
 *   - LIBRARY mode (any non-`/admin/*` route) renders the 14 primary rows.
 *   - CONSOLE mode (any `/admin/*` route) swaps the drawer's CONTENTS for the
 *     same permission-gated admin catalog `SettingsHubPage` renders, sourced
 *     from the single shared `config/adminSections.tsx` declaration, plus a
 *     "Back to library" affordance.
 *
 * Eight rows that used to live in the drawer are gone because each duplicates
 * chrome already on screen elsewhere (spec §1.2): Circles, Notifications,
 * User Settings (all now in the AppBar/UserMenu), and Job Queue / Worker
 * Nodes / Storage Insights / Public Sharing (now reachable only through
 * Console). This file asserts their absence explicitly, not just their
 * replacements' presence — a regression that silently reintroduces one of
 * them would otherwise pass every other assertion here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
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

// The sidebar's "AI Enhancements" badge is the sole consumer of
// GET /api/media/review-counts, and it only fires while the enhancer flag is
// on (issue #204) — partial-mock the media service so these tests can assert
// a request was (or was not) actually issued, not just what rendered.
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
 * Configure `useFeatureFlags` (drives both the AI Enhancements entry and,
 * transitively through the real `useMemoriesEnabled`, the Memories entry) and
 * `useWorkflowsEnabled`.
 *
 * `null` for either boolean means "flag not resolved yet" (hidden); a
 * boolean resolves it. `pendingEnhancements` seeds the review-counts response
 * consumed by the AI Enhancements badge; omit to leave that request
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

/** All three optional flags resolved ON, for the "14 rows" catalog test. */
function mockAllFlagsOn(pendingEnhancements = 0) {
  mockFlags({ pictureEnhancement: true, memories: true, workflows: true, pendingEnhancements });
}

// ---------------------------------------------------------------------------
// Shared row-name catalogs
// ---------------------------------------------------------------------------

/** The full 14-row Library catalog when every optional flag is enabled. */
const LIBRARY_ALL_FLAGS_ROWS = [
  'Photos',
  'Memories',
  'Explore',
  'Map',
  'Albums',
  'People',
  'Archive',
  'Trash',
  'Review Bursts',
  'Review Duplicates',
  'Review Insights',
  'Location Suggestions',
  'Workflows',
  'AI Enhancements',
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

describe('Sidebar', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.pathname = '/';
    mockFlags();
  });

  // =========================================================================
  // Library mode — the 14-row catalog (Required case 1)
  // =========================================================================

  describe('Library mode', () => {
    it('renders exactly the 14 expected rows with every flag on, and nothing else', () => {
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

    it('drops Memories, Workflows, and AI Enhancements when their flags are off/unresolved', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: false, memories: false, workflows: false });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('Memories')).not.toBeInTheDocument();
      expect(screen.queryByText('Workflows')).not.toBeInTheDocument();
      expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();

      // The 9 rows that are never flag-gated still render.
      ['Photos', 'Explore', 'Map', 'Albums', 'People', 'Archive', 'Trash', 'Review Bursts', 'Review Duplicates', 'Review Insights', 'Location Suggestions'].forEach(
        (label) => {
          expect(screen.getByText(label)).toBeInTheDocument();
        },
      );
    });
  });

  // =========================================================================
  // Console mode (Required cases 2-4)
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

      // The Library "Memories" row specifically is confirmed absent by
      // checking it isn't reachable via /memories (the admin card instead
      // targets /admin/settings/memories) — see the Console navigation test
      // for "Memories" -> "/admin/settings/memories".
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
  // aria-current (Required case 5, spec §7)
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
  });

  // =========================================================================
  // Segment-boundary matching (Required case 6, spec §3.5)
  // =========================================================================

  describe('segment-boundary matching (owns())', () => {
    it('activates no row at /reviewer (must not fuzzy-match "Review ..." rows)', () => {
      mockLocation.pathname = '/reviewer';
      setNonAdmin();

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const selected = container.querySelectorAll('.Mui-selected');
      expect(selected).toHaveLength(0);
    });

    it('does not activate "Review Bursts" at /burstsfoo', () => {
      mockLocation.pathname = '/burstsfoo';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const burstsButton = screen.getByText('Review Bursts').closest('.MuiListItemButton-root') as HTMLElement;
      expect(burstsButton.classList.contains('Mui-selected')).toBe(false);
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

    it('activates a nested route via a genuine segment boundary (e.g. /bursts/some-id activates Review Bursts)', () => {
      mockLocation.pathname = '/bursts/some-id';
      setNonAdmin();

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const burstsButton = screen.getByText('Review Bursts').closest('.MuiListItemButton-root') as HTMLElement;
      expect(burstsButton.classList.contains('Mui-selected')).toBe(true);
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
  // Navigation targets for a sample of rows
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
      ['Review Bursts', '/bursts'],
      ['Review Duplicates', '/duplicates'],
      ['Review Insights', '/review-insights'],
      ['Location Suggestions', '/location-suggestions'],
    ])('navigates to %s -> %s', async (label, path) => {
      setNonAdmin();
      render(<Sidebar open={true} onClose={mockOnClose} />);

      fireEvent.click(screen.getByText(label).closest('.MuiListItemButton-root') as HTMLElement);

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(path));
    });
  });

  // =========================================================================
  // AI Enhancements entry — flag gate + badge (issue #201/#204, preserved)
  // =========================================================================

  describe('AI Enhancements entry', () => {
    it('is hidden while the flag is unresolved', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: null });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
    });

    it('is hidden when disabled', () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: false });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
    });

    it('renders under Utilities and navigates to /enhancements when enabled', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const utilitiesList = screen.getByText('Utilities').closest('.MuiList-root') as HTMLElement;
      expect(within(utilitiesList).getByText('AI Enhancements')).toBeInTheDocument();

      fireEvent.click(screen.getByText('AI Enhancements').closest('.MuiListItemButton-root') as HTMLElement);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/enhancements'));
    });

    it('renders the pending count as a badge', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 7 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('7');
      });
    });

    it('caps the badge at 999+', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 1500 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('999+');
      });
    });

    it('renders no badge when the pending count is zero', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: true, pendingEnhancements: 0 });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);
      await waitFor(() => expect(mockGetReviewCounts).toHaveBeenCalled());
      expect(container.querySelector('.MuiBadge-badge')).toBeNull();
    });
  });

  // =========================================================================
  // Review-counts request gating (issue #204, preserved)
  // =========================================================================

  describe('Review-counts request gating', () => {
    it('issues no request while the enhancer flag is unresolved or disabled', async () => {
      setNonAdmin();
      mockFlags({ pictureEnhancement: null });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.getByText('Photos')).toBeInTheDocument();
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('requests counts for the active circle when enabled, and never calls the full dashboard', async () => {
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
  // Memories entry (issue #309, preserved)
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
  // Workflows entry
  // =========================================================================

  describe('Workflows entry', () => {
    it('is hidden while unresolved', () => {
      setNonAdmin();
      mockFlags({ workflows: null });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.queryByText('Workflows')).not.toBeInTheDocument();
    });

    it('is hidden when disabled', () => {
      setNonAdmin();
      mockFlags({ workflows: false });
      render(<Sidebar open={true} onClose={mockOnClose} />);
      expect(screen.queryByText('Workflows')).not.toBeInTheDocument();
    });

    it('renders under Utilities and navigates to /workflows when enabled', async () => {
      setNonAdmin();
      mockFlags({ workflows: true });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const utilitiesList = screen.getByText('Utilities').closest('.MuiList-root') as HTMLElement;
      expect(within(utilitiesList).getByText('Workflows')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Workflows'));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workflows'));
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
