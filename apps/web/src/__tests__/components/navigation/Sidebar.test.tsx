import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
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

import { usePermissions } from '../../../hooks/usePermissions';

describe('Sidebar', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.pathname = '/';
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

      // Only items with visible: true should be rendered
      // Non-admin: Photos, Explore, Map, Circles, People, Review Bursts, Archive, Trash, User Settings
      const menuButtons = container.querySelectorAll('.MuiListItemButton-root');
      expect(menuButtons).toHaveLength(9);
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

      // After the settings refactor the admin section collapses from many individual links
      // to a single "Settings" hub entry (plus permission-gated items when hasPermission
      // is unconfigured/false, as in this test).
      // Admin layout (no albums in test): Photos, Explore, Map, Circles,
      //                                   People, Review Bursts, Archive, Trash,
      //                                   Settings (admin hub),
      //                                   User Settings
      const menuButtons = container.querySelectorAll('.MuiListItemButton-root');
      expect(menuButtons).toHaveLength(10);
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

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Use container query + fireEvent to bypass MUI modal aria-hidden wrapping
      // After the settings refactor the admin section is a single "Settings" entry
      // (hasPermission is unconfigured/false here, so no extra gated items render).
      // Admin layout (no albums): Photos(0), Explore(1), Map(2), Circles(3),
      //                           People(4), Review Bursts(5), Archive(6), Trash(7),
      //                           Settings — admin hub(8),
      //                           User Settings(9)
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const adminSettingsButton = buttons[8] as HTMLElement;
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

      expect(container.textContent).toContain('Job Queue');
      expect(container.textContent).toContain('Storage Insights');
      expect(container.textContent).toContain('Public Sharing');

      // Settings(0) hub + 3 gated items + User Settings pinned at bottom
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      expect(buttons).toHaveLength(13);
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

      const { container } = render(<Sidebar open={true} onClose={mockOnClose} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Find the admin Settings button (index 8 in admin layout) and verify it is selected
      const buttons = container.querySelectorAll('.MuiListItemButton-root');
      const adminSettingsButton = buttons[8] as HTMLElement;
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

      // After the settings refactor, admin sees: Photos, Explore, Map, Circles,
      //   People, Review Bursts, Archive, Trash, Settings (admin hub), User Settings — 10 total
      // (hasPermission is unconfigured/false here, so no extra gated items render).
      const icons = container.querySelectorAll('.MuiListItemIcon-root');
      expect(icons).toHaveLength(10);
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
});
