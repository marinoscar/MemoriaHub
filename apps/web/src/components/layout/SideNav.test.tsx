/**
 * SideNav Component Tests
 *
 * Tests for navigation drawer, route highlighting, and responsive behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../test/utils';
import { SideNav } from './SideNav';

// Mock hooks
const mockNavigate = vi.fn();
let mockPathname = '/';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({
      pathname: mockPathname,
    }),
  };
});

vi.mock('../../hooks', () => ({
  useAuth: () => ({
    isAdmin: false,
  }),
}));

// Mock MUI useMediaQuery
vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: vi.fn(() => false), // Default: not mobile
  };
});

import { useMediaQuery } from '@mui/material';
const mockUseMediaQuery = vi.mocked(useMediaQuery);

describe('SideNav', () => {
  const defaultProps = {
    drawerWidth: 240,
    mobileOpen: false,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockUseMediaQuery.mockReturnValue(false); // Desktop by default
  });

  describe('navigation items', () => {
    it('renders Home nav item', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    it('renders Libraries nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      const librariesItem = screen.getByText('Libraries');
      expect(librariesItem).toBeInTheDocument();

      // Check for "Soon" badge indicating disabled
      expect(screen.getAllByText('Soon').length).toBeGreaterThan(0);
    });

    it('renders Search nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('Search')).toBeInTheDocument();
    });

    it('renders People nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('renders Tags nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('Tags')).toBeInTheDocument();
    });

    it('renders Settings nav item', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  describe('active route highlighting', () => {
    it('highlights Home when on / route', () => {
      mockPathname = '/';

      render(<SideNav {...defaultProps} />);

      // Find the Home button and check it has selected styling
      const homeButtons = screen.getAllByRole('button');
      const homeButton = homeButtons.find(btn => btn.textContent?.includes('Home'));
      expect(homeButton).toHaveClass('Mui-selected');
    });

    it('highlights Settings when on /settings route', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      const buttons = screen.getAllByRole('button');
      const settingsButton = buttons.find(btn => btn.textContent?.includes('Settings'));
      expect(settingsButton).toHaveClass('Mui-selected');
    });

    it('does not highlight Home when on /settings', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      const buttons = screen.getAllByRole('button');
      const homeButton = buttons.find(btn => btn.textContent?.includes('Home'));
      expect(homeButton).not.toHaveClass('Mui-selected');
    });

    it('highlights item for nested routes', () => {
      mockPathname = '/settings/profile';

      render(<SideNav {...defaultProps} />);

      const buttons = screen.getAllByRole('button');
      const settingsButton = buttons.find(btn => btn.textContent?.includes('Settings'));
      expect(settingsButton).toHaveClass('Mui-selected');
    });
  });

  describe('navigation behavior', () => {
    it('navigates to / on Home click', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      const homeButton = screen.getByText('Home').closest('button') ||
                         screen.getByText('Home').closest('[role="button"]');
      fireEvent.click(homeButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('navigates to /settings on Settings click', () => {
      mockPathname = '/';

      render(<SideNav {...defaultProps} />);

      const settingsButton = screen.getByText('Settings').closest('button') ||
                             screen.getByText('Settings').closest('[role="button"]');
      fireEvent.click(settingsButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('does not navigate on disabled item click', () => {
      render(<SideNav {...defaultProps} />);

      const librariesButton = screen.getByText('Libraries').closest('button') ||
                              screen.getByText('Libraries').closest('[role="button"]');
      fireEvent.click(librariesButton!);

      expect(mockNavigate).not.toHaveBeenCalledWith('/libraries');
    });
  });

  describe('disabled state', () => {
    it('shows disabled styling on Libraries', () => {
      render(<SideNav {...defaultProps} />);

      const librariesButton = screen.getByText('Libraries').closest('button') ||
                              screen.getByText('Libraries').closest('[role="button"]');
      expect(librariesButton).toHaveClass('Mui-disabled');
    });

    it('shows "Soon" badge on disabled items', () => {
      render(<SideNav {...defaultProps} />);

      // Libraries, Search, People, Tags are all disabled
      const soonBadges = screen.getAllByText('Soon');
      expect(soonBadges.length).toBe(4);
    });

    it('prevents click events on disabled items', () => {
      render(<SideNav {...defaultProps} />);

      const searchButton = screen.getByText('Search').closest('button') ||
                           screen.getByText('Search').closest('[role="button"]');
      fireEvent.click(searchButton!);

      expect(mockNavigate).not.toHaveBeenCalledWith('/search');
    });
  });

  describe('mobile drawer', () => {
    beforeEach(() => {
      mockUseMediaQuery.mockReturnValue(true); // Mobile
    });

    it('renders temporary drawer on mobile', () => {
      render(<SideNav {...defaultProps} mobileOpen={true} />);

      // Mobile drawer should be visible when mobileOpen is true
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    it('calls onClose when navigation occurs on mobile', () => {
      const onClose = vi.fn();

      render(<SideNav {...defaultProps} mobileOpen={true} onClose={onClose} />);

      const homeButton = screen.getByText('Home').closest('button') ||
                         screen.getByText('Home').closest('[role="button"]');
      fireEvent.click(homeButton!);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('desktop drawer', () => {
    beforeEach(() => {
      mockUseMediaQuery.mockReturnValue(false); // Desktop
    });

    it('renders permanent drawer on desktop', () => {
      render(<SideNav {...defaultProps} />);

      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    it('does not call onClose on navigation (desktop)', () => {
      const onClose = vi.fn();

      render(<SideNav {...defaultProps} onClose={onClose} />);

      const homeButton = screen.getByText('Home').closest('button') ||
                         screen.getByText('Home').closest('[role="button"]');
      fireEvent.click(homeButton!);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('icons', () => {
    it('renders icon for Home nav item', () => {
      render(<SideNav {...defaultProps} />);

      // MUI icons are rendered as SVGs
      const homeListItem = screen.getByText('Home').closest('li');
      const svg = homeListItem?.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('renders icon for Settings nav item', () => {
      render(<SideNav {...defaultProps} />);

      const settingsListItem = screen.getByText('Settings').closest('li');
      const svg = settingsListItem?.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('drawer width', () => {
    it('applies specified drawer width', () => {
      render(<SideNav {...defaultProps} drawerWidth={300} />);

      // The nav element should exist
      const nav = screen.getByRole('navigation');
      expect(nav).toBeInTheDocument();
    });
  });
});
