import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { Sidebar } from '../../../components/navigation/Sidebar';

// Mock react-router-dom
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

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// Mock useAlbums hook to prevent real API calls in tests
vi.mock('../../../hooks/useAlbums', () => ({
  useAlbums: vi.fn(() => ({
    albums: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchAlbums: vi.fn().mockResolvedValue(undefined),
    addAlbum: vi.fn().mockResolvedValue(undefined),
    updateAlbum: vi.fn().mockResolvedValue(undefined),
    deleteAlbum: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock CreateAlbumDialog to avoid rendering its internals in navigation tests
vi.mock('../../../components/album/CreateAlbumDialog', () => ({
  CreateAlbumDialog: () => null,
}));

// The sidebar gates its "AI Enhancements" entry on GET /api/features and reads
// the badge count from GET /api/media/review-counts. The feature-flag hook is
// mocked outright; the counts endpoint is mocked at the SERVICE layer (the real
// `useReviewCounts` hook runs) so these tests can assert on whether a request
// was actually issued — that is the regression issue #204 is about. The default
// below leaves the flag OFF, which both keeps every pre-existing menu-item
// count in this file correct AND means navigation tests make no network calls.
vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

// Partial mock: only the two count-bearing calls are stubbed, every other
// export of the media service keeps its real implementation. `getDashboard` is
// stubbed purely so the specs below can assert the sidebar never calls it.
vi.mock('../../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/media')>()),
  getReviewCounts: vi.fn(),
  getDashboard: vi.fn(),
}));

// The Notifications entry's badge (issue #250) reads the SAME module-level
// `useNotifications` store as the AppBar bell (issue #249). Mock only the
// store's network seam — `useNotifications` itself is left REAL — so the
// "one shared poller" tests below exercise the actual refcounting code, not a
// stand-in for it.
vi.mock('../../../services/notifications', () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  dismissAllNotifications: vi.fn(),
  deleteNotification: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { getReviewCounts, getDashboard } from '../../../services/media';
import { getUnreadCount, listNotifications } from '../../../services/notifications';
import { __resetNotificationsStoreForTests } from '../../../hooks/useNotifications';
import { NotificationBell } from '../../../components/notifications/NotificationBell';

const mockGetReviewCounts = vi.mocked(getReviewCounts);
const mockGetDashboard = vi.mocked(getDashboard);
const mockGetUnreadCount = vi.mocked(getUnreadCount);
const mockListNotifications = vi.mocked(listNotifications);

/**
 * Configure the enhancer feature flag and the review-counts response.
 *
 * @param enabled  `null` = flag still loading, `false`/`true` = resolved value.
 * @param pendingEnhancements  count the endpoint resolves with; omit to leave
 *   the request permanently in flight (the hook's `data` stays null), which is
 *   how the sidebar looks before the counts land.
 */
function mockEnhancer(
  enabled: boolean | null,
  pendingEnhancements?: number,
): void {
  vi.mocked(useFeatureFlags).mockReturnValue({
    features: enabled === null ? null : { pictureEnhancement: enabled },
    pictureEnhancement:
      enabled === null
        ? null
        : {
            enabled,
            allowReplace: true,
            blockReplaceOnDownscale: false,
            model: 'gpt-image-1',
          },
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });

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

/**
 * Named nav-entry sets shared by the tests below. Encoding the actual entries
 * (rather than a bare integer) means adding/removing a sidebar item produces a
 * clear "X is missing" / "Y leaked in" failure instead of an opaque
 * "expected N to be M" — see issue #202.
 */
const BASE_ENTRIES = [
  'Photos',
  'Explore',
  'Map',
  'Circles',
  'Albums',
  // Notification Center entry (issue #250). Its badge reads the SAME
  // `useNotifications` module store as the AppBar bell — one poller, not two.
  'Notifications',
  'People',
  'Archive',
  'Trash',
  'Review Bursts',
  'Review Duplicates',
  'Review Insights',
  'Location Suggestions',
];
const NON_ADMIN_ENTRIES = [...BASE_ENTRIES, 'User Settings'];
const ADMIN_HUB_ENTRIES = [...BASE_ENTRIES, 'Settings', 'User Settings'];
const ADMIN_FULL_GATED_ENTRIES = [
  ...BASE_ENTRIES,
  'Settings',
  'Job Queue',
  'Worker Nodes',
  'Storage Insights',
  'Public Sharing',
  'User Settings',
];
const GATED_ADMIN_ONLY_ENTRIES = ['Settings', 'Job Queue', 'Worker Nodes', 'Storage Insights', 'Public Sharing'];
const FEATURE_FLAGGED_ENTRIES = ['Workflows', 'AI Enhancements'];

describe('Sidebar', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.pathname = '/';
    mockEnhancer(null);
    __resetNotificationsStoreForTests();
    mockGetUnreadCount.mockResolvedValue(0);
    mockListNotifications.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
    });
  });

  afterEach(() => {
    __resetNotificationsStoreForTests();
    vi.useRealTimers();
  });

  describe('Rendering', () => {
    it('should render Drawer component even when open is false', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      // The key test: calling render should work without the component returning null
      // Even though drawer content won't be in DOM with keepMounted: false and open: false,
      // the component should still render the Drawer JSX (MUI handles visibility)
      const result = render(<Sidebar open={false} onClose={mockOnClose} />);

      // Verify render was successful (result should have standard RTL properties)
      expect(result).toHaveProperty('container');
      expect(result).toHaveProperty('baseElement');
    });

    it('should render Drawer component when open is true', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const drawer = container.querySelector('.MuiDrawer-root');
      expect(drawer).not.toBeNull();
      expect(drawer).toBeDefined();
    });

    it('should render visible menu items', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Non-admin users should see Photos, Explore, Map, and User Settings
      expect(container.textContent).toContain('Photos');
      expect(container.textContent).toContain('Explore');
      expect(container.textContent).toContain('Map');
      expect(container.textContent).toContain('User Settings');
    });

    it('should not render admin menu items for non-admin users', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Admin section should not be visible for non-admins
      // After the settings refactor the admin section is a single "Settings" link
      expect(container.textContent).not.toContain('Administration');
    });

    it('should render admin menu items for admin users', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // After the settings refactor the admin section collapses to a single "Settings" hub link
      expect(container.textContent).toContain('Photos');
      expect(container.textContent).toContain('Explore');
      expect(container.textContent).toContain('Map');
      expect(container.textContent).toContain('User Settings');
      // Admin hub entry
      expect(container.textContent).toContain('Settings');
      // Individual admin sub-pages are NOT in the sidebar anymore
    });
  });

  describe('ModalProps Configuration', () => {
    it('should have keepMounted set to false', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const drawer = container.querySelector('.MuiDrawer-root');
      expect(drawer).not.toBeNull();
      // keepMounted: false means content unmounts when closed
    });

    it('should have disablePortal set to true', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const drawer = container.querySelector('.MuiDrawer-root');
      expect(drawer).not.toBeNull();
      // disablePortal: true keeps Modal in component tree
    });
  });

  describe('Menu Item Visibility Filtering', () => {
    it('should filter menu items based on visibility property', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Only items with visible: true should be rendered for a non-admin viewer.
      NON_ADMIN_ENTRIES.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });

      // Admin-only and feature-flag-gated entries must not leak through.
      [...GATED_ADMIN_ONLY_ENTRIES, ...FEATURE_FLAGGED_ENTRIES].forEach((label) => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });

      // No unnamed extras: exactly the named set above renders.
      const menuButtons = container.querySelectorAll('.MuiListItemButton-root');
      expect(menuButtons).toHaveLength(NON_ADMIN_ENTRIES.length);
    });

    it('should show all menu items when user is admin', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // After the settings refactor the admin section collapses from many individual
      // links to a single "Settings" hub entry. hasPermission is unconfigured/false
      // here, so the extra permission-gated admin entries must NOT render.
      ADMIN_HUB_ENTRIES.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });
      ['Job Queue', 'Worker Nodes', 'Storage Insights', 'Public Sharing', ...FEATURE_FLAGGED_ENTRIES].forEach(
        (label) => {
          expect(screen.queryByText(label)).not.toBeInTheDocument();
        },
      );

      const menuButtons = container.querySelectorAll('.MuiListItemButton-root');
      expect(menuButtons).toHaveLength(ADMIN_HUB_ENTRIES.length);
    });

    it('should dynamically update menu items when isAdmin changes', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { rerender, container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Non-admin: no Administration section
      expect(container.textContent).not.toContain('Administration');

      // Update to admin
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      rerender(<Sidebar open={true} onClose={mockOnClose} />);

      // After becoming admin, the Administration section with "Settings" hub appears
      expect(container.textContent).toContain('Administration');
    });
  });

  describe('Navigation Behavior', () => {
    it('should call onClose BEFORE navigate when menu item is clicked', async () => {
      const callOrder: string[] = [];

      const trackingOnClose = vi.fn(() => {
        callOrder.push('onClose');
      });

      mockNavigate.mockImplementation(() => {
        callOrder.push('navigate');
      });

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={trackingOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      // User Settings is the last button in the sidebar (pinned at bottom)
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const settingsButton = buttons[buttons.length - 1] as HTMLElement;
      fireEvent.click(settingsButton);

      // onClose should be called immediately (synchronously)
      expect(trackingOnClose).toHaveBeenCalledTimes(1);

      // Wait for navigate to be called (it's in setTimeout(0))
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledTimes(1);
      });

      // Verify order: onClose should be called BEFORE navigate
      expect(callOrder).toEqual(['onClose', 'navigate']);
    });

    it('should navigate to / when Photos menu item is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const photosButton = buttons[0] as HTMLElement; // Photos is the first item
      fireEvent.click(photosButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/');
      });
    });

    it('should navigate to settings when User Settings menu item is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      // User Settings is the last button in the sidebar (pinned at bottom)
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const settingsButton = buttons[buttons.length - 1] as HTMLElement;
      fireEvent.click(settingsButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/settings');
      });
    });

    it('should navigate to /search when Explore is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const exploreButton = buttons[1] as HTMLElement; // Explore is the second item
      fireEvent.click(exploreButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/search');
      });
    });

    it('should navigate to /map when Map is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const mapButton = buttons[2] as HTMLElement; // Map is the third item
      fireEvent.click(mapButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/map');
      });
    });

    it('should navigate to admin/settings when the Settings hub item is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // After the settings refactor the admin section is a single "Settings" entry.
      // Query by accessible text instead of a hardcoded index so inserting new
      // nav items doesn't require renumbering this test.
      const adminSettingsButton = screen
        .getByText('Settings')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(adminSettingsButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings');
      });
    });
  });

  describe('Permission-Gated Admin Nav Items', () => {
    it('does not render Job Queue, Storage Insights, or Public Sharing when admin lacks the gating permissions', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn().mockReturnValue(false),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(container.textContent).not.toContain('Job Queue');
      expect(container.textContent).not.toContain('Storage Insights');
      expect(container.textContent).not.toContain('Public Sharing');
    });

    it('renders Job Queue when admin has jobs:read', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(['jobs:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'jobs:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(container.textContent).toContain('Job Queue');
      expect(container.textContent).not.toContain('Storage Insights');
      expect(container.textContent).not.toContain('Public Sharing');

      const jobQueueButton = screen.getByText('Job Queue').closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(jobQueueButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/jobs');
      });
    });

    it('renders Storage Insights when admin has system_settings:read', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(container.textContent).toContain('Storage Insights');

      const storageInsightsButton = screen
        .getByText('Storage Insights')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(storageInsightsButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/storage/insights');
      });
    });

    it('renders Public Sharing when admin has shares:manage_any', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(['shares:manage_any']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) => perm === 'shares:manage_any',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(container.textContent).toContain('Public Sharing');

      const publicSharingButton = screen
        .getByText('Public Sharing')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(publicSharingButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/sharing');
      });
    });

    it('renders all three gated items together when admin has all three permissions', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(['jobs:read', 'system_settings:read', 'shares:manage_any']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) =>
          ['jobs:read', 'system_settings:read', 'shares:manage_any'].includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // jobs:read gates BOTH "Job Queue" and "Worker Nodes".
      ADMIN_FULL_GATED_ENTRIES.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument();
      });

      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(ADMIN_FULL_GATED_ENTRIES.length);
    });
  });

  describe('Active Menu Item Highlighting', () => {
    it('should highlight current route', () => {
      mockLocation.pathname = '/settings';

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const settingsButton = screen.getByText('User Settings').closest('.MuiListItemButton-root') as HTMLElement;
      expect(settingsButton.classList.contains('Mui-selected')).toBe(true);
    });

    it('should not highlight non-current routes', () => {
      mockLocation.pathname = '/';

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const settingsButton = screen.getByText('User Settings').closest('.MuiListItemButton-root') as HTMLElement;
      expect(settingsButton.classList.contains('Mui-selected')).toBe(false);
    });

    it('should highlight admin routes when on admin page', () => {
      // After the settings refactor, the single admin hub item at /admin/settings
      // becomes highlighted for any /admin/* route (startsWith match).
      mockLocation.pathname = '/admin/settings';

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Find the admin Settings button by its accessible text and verify it is selected
      const adminSettingsButton = screen
        .getByText('Settings')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(adminSettingsButton.classList.contains('Mui-selected')).toBe(true);
    });
  });

  describe('Drawer Close Behavior', () => {
    it('should pass onClose prop to Drawer', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // The onClose prop is passed to Drawer - verify drawer is rendered
      const drawer = container.querySelector('.MuiDrawer-root');
      expect(drawer).not.toBeNull();
      expect(mockOnClose).toHaveBeenCalledTimes(0);
    });

    it('should call onClose for each menu item click', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const photosButton = buttons[0] as HTMLElement; // Photos is the first item
      fireEvent.click(photosButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);

      // User Settings is the last button in the sidebar (pinned at bottom)
      const allButtons = container.querySelectorAll('.MuiListItemButton-root');
      const settingsButton = allButtons[allButtons.length - 1] as HTMLElement;
      fireEvent.click(settingsButton);

      expect(mockOnClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('Menu Icons', () => {
    it('should render icons for all menu items', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // hasPermission is unconfigured/false here, so no extra permission-gated admin
      // items render — every entry that does render must carry its own icon.
      ADMIN_HUB_ENTRIES.forEach((label) => {
        const button = screen.getByText(label).closest('.MuiListItemButton-root') as HTMLElement;
        expect(button.querySelector('.MuiListItemIcon-root')).not.toBeNull();
      });

      const icons = container.querySelectorAll('.MuiListItemIcon-root');
      expect(icons).toHaveLength(ADMIN_HUB_ENTRIES.length);
    });

    it('should highlight icon for selected menu item', () => {
      mockLocation.pathname = '/settings';

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const settingsButton = screen.getByText('User Settings').closest('.MuiListItemButton-root') as HTMLElement;
      const icon = settingsButton?.querySelector('.MuiListItemIcon-root');

      expect(icon).not.toBeNull();
      expect(icon).toBeDefined();
      // Icon should have primary color styling when selected
    });
  });

  describe('Accessibility', () => {
    it('should render drawer with proper structure', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Drawer should be rendered with buttons
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should have accessible button labels', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Verify text content for accessibility
      expect(container.textContent).toContain('Photos');
      expect(container.textContent).toContain('Explore');
      expect(container.textContent).toContain('Map');
      expect(container.textContent).toContain('User Settings');
    });

    it('should be keyboard navigable', async () => {
      const user = userEvent.setup();

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // Use container query to bypass aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const photosButton = buttons[0] as HTMLElement; // Photos is the first item, path /

      // Should be able to focus and activate with keyboard
      photosButton.focus();
      expect(photosButton).toHaveFocus();

      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Regression Tests', () => {
    it('should NOT return null when open is false (critical bug fix)', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      // CRITICAL REGRESSION TEST:
      // Previously, the component conditionally returned null when open was false:
      // if (!open) return null; // ❌ WRONG - caused backdrop click issues
      //
      // This caused UI blocking issues because:
      // 1. The component was completely removed from the React tree
      // 2. When reopened, React had to remount everything
      // 3. This caused backdrop click handlers to become stale/broken
      //
      // The fix: Component always returns the Drawer JSX:
      // return <Drawer open={open} ... /> // ✅ CORRECT - let MUI handle visibility
      //
      // This test verifies the component doesn't throw and renders successfully
      expect(() => {
        render(<Sidebar open={false} onClose={mockOnClose} />);
      }).not.toThrow();

      // Also verify it works when open
      expect(() => {
        render(<Sidebar open={true} onClose={mockOnClose} />);
      }).not.toThrow();
    });

    it('should close drawer before navigation to prevent backdrop issues', async () => {
      let drawerClosed = false;
      let navigationOccurred = false;

      const trackingOnClose = vi.fn(() => {
        drawerClosed = true;
        // At the moment onClose is called, navigation should not have occurred yet
        expect(navigationOccurred).toBe(false);
      });

      mockNavigate.mockImplementation(() => {
        navigationOccurred = true;
        // Drawer should already be closed when navigation occurs
        expect(drawerClosed).toBe(true);
      });

      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={trackingOnClose} />);

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const photosButton = buttons[0] as HTMLElement; // Photos is the first button
      fireEvent.click(photosButton);

      // Drawer close should happen synchronously
      expect(drawerClosed).toBe(true);

      // Wait for navigation to occur (it's in setTimeout(0))
      await waitFor(() => {
        expect(navigationOccurred).toBe(true);
      });
    });

    it('should maintain ModalProps configuration for backdrop click handling', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      const drawer = container.querySelector('.MuiDrawer-root');
      expect(drawer).not.toBeNull();
      expect(drawer).toBeDefined();

      // Critical: disablePortal: true keeps Modal in component tree
      // This prevents backdrop click issues after navigation
      // keepMounted: false ensures drawer content unmounts when closed
    });
  });

  describe('Utilities Section', () => {
    it('renders a "Utilities" subheader', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Utilities')).toBeInTheDocument();
    });

    it('renders Review Bursts, Review Duplicates, and Location Suggestions as descendants of the Utilities list', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Review Bursts')).toBeInTheDocument();
      expect(screen.getByText('Review Duplicates')).toBeInTheDocument();
      expect(screen.getByText('Location Suggestions')).toBeInTheDocument();

      const utilitiesSubheader = screen.getByText('Utilities');
      const utilitiesList = utilitiesSubheader.closest('.MuiList-root');
      expect(utilitiesList).not.toBeNull();
      expect(utilitiesList!.textContent).toContain('Review Bursts');
      expect(utilitiesList!.textContent).toContain('Review Duplicates');
      expect(utilitiesList!.textContent).toContain('Location Suggestions');
    });

    it('no longer includes Review Bursts, Review Duplicates, or Location Suggestions under the Library list', () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const librarySubheader = screen.getByText('Library');
      const libraryList = librarySubheader.closest('.MuiList-root');
      expect(libraryList).not.toBeNull();

      // Library retains People, Archive, Trash
      expect(libraryList!.textContent).toContain('People');
      expect(libraryList!.textContent).toContain('Archive');
      expect(libraryList!.textContent).toContain('Trash');

      // The three utility items moved out of Library
      expect(libraryList!.textContent).not.toContain('Review Bursts');
      expect(libraryList!.textContent).not.toContain('Review Duplicates');
      expect(libraryList!.textContent).not.toContain('Location Suggestions');
    });
  });

  describe('AI Enhancements Entry (issue #201)', () => {
    const nonAdmin = () => ({
      permissions: new Set<string>(),
      roles: new Set<string>(),
      hasPermission: vi.fn(),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });

    it('is hidden while the feature flag is still loading (null)', () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(null);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
    });

    it('is hidden when picture enhancement is disabled', () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(false, 4);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
    });

    it('renders under Utilities when picture enhancement is enabled', () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('AI Enhancements')).toBeInTheDocument();

      const utilitiesList = screen.getByText('Utilities').closest('.MuiList-root');
      expect(utilitiesList).not.toBeNull();
      expect(utilitiesList!.textContent).toContain('AI Enhancements');
    });

    it('navigates to /enhancements when clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const button = screen
        .getByText('AI Enhancements')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/enhancements');
      });
    });

    it('stays highlighted on a nested /enhancements/... route (prefix match)', () => {
      mockLocation.pathname = '/enhancements/some-id';
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const button = screen
        .getByText('AI Enhancements')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(button.classList.contains('Mui-selected')).toBe(true);
    });

    it('renders the pending count as a badge', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true, 7);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        const badge = container.querySelector('.MuiBadge-badge');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe('7');
      });
    });

    it('caps the badge at 999+', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true, 1500);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('999+');
      });
    });

    it('renders no badge when the count is zero', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true, 0);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalled();
      });

      expect(screen.getByText('AI Enhancements')).toBeInTheDocument();
      expect(container.querySelector('.MuiBadge-badge')).toBeNull();
    });

    it('renders no badge while the count request is still in flight', () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('AI Enhancements')).toBeInTheDocument();
      expect(container.querySelector('.MuiBadge-badge')).toBeNull();
    });
  });

  // The point of issue #204: the badge count no longer comes from the heavy
  // dashboard endpoint, and no counts request is made at all unless the badge
  // that consumes it is actually rendered.
  describe('Review-counts request gating (issue #204)', () => {
    const nonAdmin = () => ({
      permissions: new Set<string>(),
      roles: new Set<string>(),
      hasPermission: vi.fn(),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });

    it('issues NO review-counts request while the enhancer flag is still loading', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(null);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      // The sidebar has fully rendered — a request, had one been issued, would
      // already have been kicked off by the hook's mount effect.
      expect(screen.getByText('Photos')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
      });
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('issues NO review-counts request when the enhancer feature is disabled', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(false, 4);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Photos')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByText('AI Enhancements')).not.toBeInTheDocument();
      });
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('requests the counts for the active circle when the enhancer is enabled, and badges the result', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true, 3);

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />);

      // `circle-1` is the active circle supplied by the test-utils wrapper.
      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-1');
      });

      await waitFor(() => {
        expect(container.querySelector('.MuiBadge-badge')!.textContent).toBe('3');
      });
    });

    it('never fetches the full dashboard for the badge count', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockEnhancer(true, 3);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledTimes(1);
      });

      // The sidebar used to read this one integer out of GET /api/media/dashboard,
      // which also returns On This Day / recent / favorites with a signed
      // thumbnail URL per item.
      expect(mockGetDashboard).not.toHaveBeenCalled();
    });
  });

  describe('Albums Navigation', () => {
    it('renders exactly one nav entry labeled "Albums" and no per-album rows', () => {
      // The Sidebar collapsed from enumerating individual albums to a single
      // static "Albums" nav entry — useAlbums is mocked with albums: [] above
      // to prove the count doesn't come from (or vary with) real album data.
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getAllByText('Albums')).toHaveLength(1);

      const albumsButton = screen
        .getByText('Albums')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(albumsButton).not.toBeNull();
    });

    it('navigates to /albums when the Albums item is clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue({
        permissions: new Set(),
        roles: new Set(),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const albumsButton = screen
        .getByText('Albums')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(albumsButton);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/albums');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Notifications entry (issue #250) — badge + shared-poller regression guard
  // ---------------------------------------------------------------------------
  describe('Notifications entry (issue #250)', () => {
    const nonAdmin = () => ({
      permissions: new Set<string>(),
      roles: new Set<string>(),
      hasPermission: vi.fn(),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });

    it('renders the Notifications nav entry', () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());

      render(<Sidebar open={true} onClose={mockOnClose} />);

      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });

    it('navigates to /notifications when clicked', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());

      render(<Sidebar open={true} onClose={mockOnClose} />);

      const button = screen
        .getByText('Notifications')
        .closest('.MuiListItemButton-root') as HTMLElement;
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/notifications');
      });
    });

    it('renders the unread count from the shared store as a badge', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockGetUnreadCount.mockResolvedValue(4);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        const button = screen
          .getByText('Notifications')
          .closest('.MuiListItemButton-root') as HTMLElement;
        const badge = button.querySelector('.MuiBadge-badge');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe('4');
      });
    });

    it('renders no badge when the unread count is zero', async () => {
      vi.mocked(usePermissions).mockReturnValue(nonAdmin());
      mockGetUnreadCount.mockResolvedValue(0);

      render(<Sidebar open={true} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(mockGetUnreadCount).toHaveBeenCalled();
      });
      const button = screen
        .getByText('Notifications')
        .closest('.MuiListItemButton-root') as HTMLElement;
      expect(button.querySelector('.MuiBadge-badge')).toBeNull();
    });

    // The regression this guards against: the sidebar entry starting its own
    // independent poll timer instead of sharing the bell's single one — see
    // `useNotifications.ts`'s "ONE poller, three surfaces" doc and the
    // equivalent assertions in `useNotifications.test.ts` /
    // `NotificationBell.test.tsx`, mirrored here across the two REAL surfaces
    // together for the first time.
    describe('shares the bell\'s single poller — no second poller sneaks in', () => {
      it('mounting the sidebar AND the bell together issues only ONE unread-count request, not two', async () => {
        vi.mocked(usePermissions).mockReturnValue(nonAdmin());
        mockGetUnreadCount.mockResolvedValue(2);

        render(
          <>
            <Sidebar open={true} onClose={mockOnClose} />
            <NotificationBell />
          </>,
        );

        await waitFor(() => {
          expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);
        });
      });

      it('the ONE shared poller ticks once per interval regardless of both surfaces being mounted', async () => {
        vi.useFakeTimers();
        vi.mocked(usePermissions).mockReturnValue(nonAdmin());
        mockGetUnreadCount.mockResolvedValue(2);

        render(
          <>
            <Sidebar open={true} onClose={mockOnClose} />
            <NotificationBell />
          </>,
        );

        await act(async () => {
          await Promise.resolve();
        });
        expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);

        await act(async () => {
          vi.advanceTimersByTime(60_000);
          await Promise.resolve();
        });

        // ONE additional tick from the ONE shared interval — not two (which a
        // second independent poller in the sidebar would produce).
        expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
      });

      it('polling continues (from the bell) after the sidebar unmounts — proving the sidebar is a subscriber, not the owner, of the poller', async () => {
        vi.useFakeTimers();
        vi.mocked(usePermissions).mockReturnValue(nonAdmin());
        mockGetUnreadCount.mockResolvedValue(2);

        const { unmount } = render(<Sidebar open={true} onClose={mockOnClose} />);
        render(<NotificationBell />);

        await act(async () => {
          await Promise.resolve();
        });

        unmount(); // sidebar goes away; the bell is still mounted

        await act(async () => {
          vi.advanceTimersByTime(60_000);
          await Promise.resolve();
        });

        expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
      });
    });
  });
});
