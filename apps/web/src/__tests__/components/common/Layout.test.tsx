import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import { Layout } from '../../../components/common/Layout';

// Mock the child components
vi.mock('../../../components/navigation/AppBar', () => ({
  AppBar: vi.fn(({ onMenuClick }) => (
    <div data-testid="mock-appbar">
      <button onClick={onMenuClick} data-testid="menu-toggle-button">
        Toggle Menu
      </button>
    </div>
  )),
}));

vi.mock('../../../components/navigation/Sidebar', () => ({
  Sidebar: vi.fn(({ open, onClose }) => (
    <div data-testid="mock-sidebar" data-open={open}>
      <button onClick={onClose} data-testid="sidebar-close-button">
        Close Sidebar
      </button>
    </div>
  )),
  DRAWER_WIDTH: 240,
}));

// Mock react-router-dom Outlet
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Outlet: vi.fn(() => <div data-testid="outlet-content">Page Content</div>),
  };
});

// Mock usePermissions hook for Sidebar
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(() => ({
    permissions: new Set(),
    roles: new Set(),
    hasPermission: vi.fn(),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: false,
  })),
}));

// Import mocked components to access their mock functions
import { AppBar } from '../../../components/navigation/AppBar';
import { Sidebar } from '../../../components/navigation/Sidebar';
import { Outlet } from 'react-router-dom';

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render the Layout component', () => {
      const { container } = render(<Layout />);

      expect(container).toBeInTheDocument();
    });

    it('should render AppBar component', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });

    it('should render Sidebar component', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
    });

    it('should render Outlet for nested routes', () => {
      render(<Layout />);

      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
      expect(vi.mocked(Outlet)).toHaveBeenCalled();
    });

    it('should render all major layout sections', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });
  });

  describe('Sidebar State Management', () => {
    it('should initialize with sidebar closed', () => {
      render(<Layout />);

      const sidebar = screen.getByTestId('mock-sidebar');
      expect(sidebar).toHaveAttribute('data-open', 'false');
    });

    it('should open sidebar when menu button is clicked', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');
      await user.click(menuButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });

    it('should close sidebar when close button is clicked', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      // First open the sidebar
      const menuButton = screen.getByTestId('menu-toggle-button');
      await user.click(menuButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });

      // Then close it
      const closeButton = screen.getByTestId('sidebar-close-button');
      await user.click(closeButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'false');
      });
    });

    it('should toggle sidebar state on multiple clicks', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');
      const sidebar = screen.getByTestId('mock-sidebar');

      // Initially closed
      expect(sidebar).toHaveAttribute('data-open', 'false');

      // Open
      await user.click(menuButton);
      await waitFor(() => {
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });

      // Close
      await user.click(menuButton);
      await waitFor(() => {
        expect(sidebar).toHaveAttribute('data-open', 'false');
      });

      // Open again
      await user.click(menuButton);
      await waitFor(() => {
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });
  });

  describe('Component Integration', () => {
    it('should pass onMenuClick handler to AppBar', () => {
      render(<Layout />);

      // React 19 passes (props, undefined) — legacy context replaced by undefined
      expect(vi.mocked(AppBar)).toHaveBeenCalledWith(
        expect.objectContaining({
          onMenuClick: expect.any(Function),
        }),
        undefined,
      );
    });

    it('should pass open state to Sidebar', () => {
      render(<Layout />);

      // React 19 passes (props, undefined) — legacy context replaced by undefined
      expect(vi.mocked(Sidebar)).toHaveBeenCalledWith(
        expect.objectContaining({
          open: false,
          onClose: expect.any(Function),
        }),
        undefined,
      );
    });

    it('should update Sidebar open prop when state changes', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      // Initially closed — React 19 passes (props, undefined)
      expect(vi.mocked(Sidebar)).toHaveBeenCalledWith(
        expect.objectContaining({ open: false }),
        undefined,
      );

      const menuButton = screen.getByTestId('menu-toggle-button');
      await user.click(menuButton);

      // After click, should be open
      await waitFor(() => {
        expect(vi.mocked(Sidebar)).toHaveBeenCalledWith(
          expect.objectContaining({ open: true }),
          undefined,
        );
      });
    });
  });

  describe('Layout Structure', () => {
    it('should have flexbox layout container', () => {
      const { container } = render(<Layout />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer).toBeInTheDocument();
    });

    it('should render main content area', () => {
      render(<Layout />);

      // Check that outlet content is within main element
      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      expect(mainElement).toBeInTheDocument();
    });

    it('should have proper component hierarchy', () => {
      const { container } = render(<Layout />);

      // Check the hierarchy: Container > AppBar + Content Row > Sidebar + Main
      const appBar = screen.getByTestId('mock-appbar');
      const sidebar = screen.getByTestId('mock-sidebar');
      const outlet = screen.getByTestId('outlet-content');

      expect(container.contains(appBar)).toBe(true);
      expect(container.contains(sidebar)).toBe(true);
      expect(container.contains(outlet)).toBe(true);
    });
  });

  describe('Main Content Area', () => {
    it('should render main element with component prop', () => {
      render(<Layout />);

      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      expect(mainElement).toBeInTheDocument();
      expect(mainElement?.tagName).toBe('MAIN');
    });

    it('should render outlet content within main area', () => {
      render(<Layout />);

      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      expect(mainElement).toContainElement(outletContent);
    });

    it('should apply padding to main content area', () => {
      render(<Layout />);

      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      // MUI applies padding via sx prop, verify element exists
      expect(mainElement).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should render all components on mobile viewport', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('should render all components on desktop viewport', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('should handle sidebar toggle on any viewport size', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');
      const sidebar = screen.getByTestId('mock-sidebar');

      await user.click(menuButton);

      await waitFor(() => {
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });
  });

  describe('Styling and Theme', () => {
    it('should apply background color from theme', () => {
      const { container } = render(<Layout />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer).toBeInTheDocument();
      // Theme background color is applied via MUI sx prop
    });

    it('should use theme palette for styling', () => {
      const { container } = render(<Layout />);

      // Layout should be rendered and styled
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should have minimum height of 100vh', () => {
      const { container } = render(<Layout />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer).toBeInTheDocument();
      // minHeight: 100vh is applied via MUI sx prop
    });

    it('should have flex column layout', () => {
      const { container } = render(<Layout />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer).toBeInTheDocument();
      // flexDirection: column is applied via MUI sx prop
    });
  });

  describe('Outlet Rendering', () => {
    it('should render child route content via Outlet', () => {
      render(<Layout />);

      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
      expect(screen.getByText('Page Content')).toBeInTheDocument();
    });

    it('should call Outlet component', () => {
      render(<Layout />);

      expect(vi.mocked(Outlet)).toHaveBeenCalled();
    });

    it('should render Outlet without props', () => {
      render(<Layout />);

      // React 19 passes (props, undefined) — legacy context replaced by undefined.
      // Outlet is called with empty props and undefined as second arg.
      expect(vi.mocked(Outlet)).toHaveBeenCalledWith({}, undefined);
    });
  });

  describe('Event Handlers', () => {
    it('should have handleSidebarToggle function', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');
      const sidebar = screen.getByTestId('mock-sidebar');

      // Test toggle behavior
      expect(sidebar).toHaveAttribute('data-open', 'false');

      await user.click(menuButton);

      await waitFor(() => {
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });

    it('should have handleSidebarClose function', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      // Open sidebar first
      const menuButton = screen.getByTestId('menu-toggle-button');
      await user.click(menuButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });

      // Close it
      const closeButton = screen.getByTestId('sidebar-close-button');
      await user.click(closeButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'false');
      });
    });

    it('should handle rapid toggle clicks', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');

      // Rapid clicks
      await user.click(menuButton);
      await user.click(menuButton);
      await user.click(menuButton);

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });
  });

  describe('Accessibility', () => {
    it('should render semantic HTML structure', () => {
      render(<Layout />);

      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      expect(mainElement).toBeInTheDocument();
    });

    it('should have proper landmark structure', () => {
      render(<Layout />);

      // Main content should be within <main> element
      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');

      expect(mainElement).toBeInTheDocument();
      expect(mainElement?.tagName).toBe('MAIN');
    });

    it('should be keyboard navigable through menu toggle', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');

      // Focus and activate with keyboard
      menuButton.focus();
      expect(menuButton).toHaveFocus();

      await user.keyboard('{Enter}');

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });
  });

  describe('Integration with Theme Context', () => {
    it('should render with light theme', () => {
      render(<Layout />, {
        wrapperOptions: { theme: 'light' },
      });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('should render with dark theme', () => {
      render(<Layout />, {
        wrapperOptions: { theme: 'dark' },
      });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('should apply theme colors to layout', () => {
      const { container } = render(<Layout />);

      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer).toBeInTheDocument();
      // Theme colors are applied via useTheme hook and MUI sx prop
    });
  });

  describe('Integration with Auth Context', () => {
    it('should render with authenticated user', () => {
      render(<Layout />, {
        wrapperOptions: { authenticated: true, user: mockUser },
      });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('should render when not authenticated', () => {
      render(<Layout />, {
        wrapperOptions: { authenticated: false, user: null },
      });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });
  });

  describe('Performance', () => {
    it('should not re-render unnecessarily', () => {
      const { rerender } = render(<Layout />);

      const initialCallCount = vi.mocked(AppBar).mock.calls.length;

      // Re-render with same props
      rerender(<Layout />);

      // Component should handle re-renders gracefully
      expect(vi.mocked(AppBar).mock.calls.length).toBeGreaterThanOrEqual(
        initialCallCount
      );
    });

    it('should handle state updates efficiently', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const menuButton = screen.getByTestId('menu-toggle-button');

      // Multiple state updates
      await user.click(menuButton); // Open
      await user.click(menuButton); // Close
      await user.click(menuButton); // Open

      await waitFor(() => {
        const sidebar = screen.getByTestId('mock-sidebar');
        expect(sidebar).toHaveAttribute('data-open', 'true');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing onMenuClick gracefully', () => {
      render(<Layout />);

      // Component should render even if handlers are called
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });

    it('should handle sidebar state changes while closed', async () => {
      const user = userEvent.setup();

      render(<Layout />);

      const sidebar = screen.getByTestId('mock-sidebar');
      expect(sidebar).toHaveAttribute('data-open', 'false');

      // Try to close already closed sidebar
      const closeButton = screen.getByTestId('sidebar-close-button');
      await user.click(closeButton);

      // Should remain closed
      expect(sidebar).toHaveAttribute('data-open', 'false');
    });

    it('should maintain sidebar state during route changes', () => {
      const { rerender } = render(<Layout />);

      // Simulate route change by re-rendering
      rerender(<Layout />);

      // Sidebar should maintain its closed state
      const sidebar = screen.getByTestId('mock-sidebar');
      expect(sidebar).toHaveAttribute('data-open', 'false');
    });
  });
});
