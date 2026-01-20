/**
 * SideNav Component Tests
 *
 * Tests for navigation drawer, route highlighting, and responsive behavior.
 * Note: SideNav renders both mobile (temporary) and desktop (permanent) drawers,
 * so we use getAllBy* queries to handle duplicate elements.
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
    mockPathname = '/media';
    mockUseMediaQuery.mockReturnValue(false); // Desktop by default
  });

  describe('navigation items', () => {
    it('renders All Media nav item', () => {
      render(<SideNav {...defaultProps} />);

      // Both drawers render the items, use getAllBy
      const allMediaItems = screen.getAllByText('All Media');
      expect(allMediaItems.length).toBeGreaterThan(0);
    });

    it('renders Libraries nav item (enabled)', () => {
      render(<SideNav {...defaultProps} />);

      const librariesItems = screen.getAllByText('Libraries');
      expect(librariesItems.length).toBeGreaterThan(0);
    });

    it('renders Search nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      const searchItems = screen.getAllByText('Search');
      expect(searchItems.length).toBeGreaterThan(0);
    });

    it('renders People nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      const peopleItems = screen.getAllByText('People');
      expect(peopleItems.length).toBeGreaterThan(0);
    });

    it('renders Tags nav item (disabled)', () => {
      render(<SideNav {...defaultProps} />);

      const tagsItems = screen.getAllByText('Tags');
      expect(tagsItems.length).toBeGreaterThan(0);
    });

    it('renders Settings nav item', () => {
      render(<SideNav {...defaultProps} />);

      const settingsItems = screen.getAllByText('Settings');
      expect(settingsItems.length).toBeGreaterThan(0);
    });
  });

  describe('active route highlighting', () => {
    it('highlights All Media when on /media route', () => {
      mockPathname = '/media';

      render(<SideNav {...defaultProps} />);

      // Find buttons with selected class
      const allButtons = screen.getAllByRole('button');
      const allMediaButtons = allButtons.filter(btn => btn.textContent?.includes('All Media'));
      const selectedAllMedia = allMediaButtons.find(btn => btn.classList.contains('Mui-selected'));
      expect(selectedAllMedia).toBeDefined();
    });

    it('highlights Settings when on /settings route', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      const allButtons = screen.getAllByRole('button');
      const settingsButtons = allButtons.filter(btn => btn.textContent?.includes('Settings'));
      const selectedSettings = settingsButtons.find(btn => btn.classList.contains('Mui-selected'));
      expect(selectedSettings).toBeDefined();
    });

    it('does not highlight All Media when on /settings', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      const allButtons = screen.getAllByRole('button');
      const allMediaButtons = allButtons.filter(btn => btn.textContent?.includes('All Media'));
      const selectedAllMedia = allMediaButtons.filter(btn => btn.classList.contains('Mui-selected'));
      expect(selectedAllMedia.length).toBe(0);
    });

    it('highlights item for nested routes', () => {
      mockPathname = '/settings/profile';

      render(<SideNav {...defaultProps} />);

      const allButtons = screen.getAllByRole('button');
      const settingsButtons = allButtons.filter(btn => btn.textContent?.includes('Settings'));
      const selectedSettings = settingsButtons.find(btn => btn.classList.contains('Mui-selected'));
      expect(selectedSettings).toBeDefined();
    });
  });

  describe('navigation behavior', () => {
    it('navigates to /media on All Media click', () => {
      mockPathname = '/settings';

      render(<SideNav {...defaultProps} />);

      // Get first All Media button (from permanent drawer on desktop)
      const allMediaItems = screen.getAllByText('All Media');
      const allMediaButton = allMediaItems[0].closest('div[role="button"]') || allMediaItems[0].closest('button');
      fireEvent.click(allMediaButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/media');
    });

    it('navigates to /settings on Settings click', () => {
      mockPathname = '/media';

      render(<SideNav {...defaultProps} />);

      const settingsItems = screen.getAllByText('Settings');
      const settingsButton = settingsItems[0].closest('div[role="button"]') || settingsItems[0].closest('button');
      fireEvent.click(settingsButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('navigates to /libraries on Libraries click', () => {
      render(<SideNav {...defaultProps} />);

      const librariesItems = screen.getAllByText('Libraries');
      const librariesButton = librariesItems[0].closest('div[role="button"]') || librariesItems[0].closest('button');
      fireEvent.click(librariesButton!);

      expect(mockNavigate).toHaveBeenCalledWith('/libraries');
    });

    it('does not navigate on disabled item click', () => {
      render(<SideNav {...defaultProps} />);

      const searchItems = screen.getAllByText('Search');
      const searchButton = searchItems[0].closest('div[role="button"]') || searchItems[0].closest('button');
      fireEvent.click(searchButton!);

      expect(mockNavigate).not.toHaveBeenCalledWith('/search');
    });
  });

  describe('disabled state', () => {
    it('shows disabled styling on Search', () => {
      render(<SideNav {...defaultProps} />);

      const searchItems = screen.getAllByText('Search');
      const searchButton = searchItems[0].closest('div[role="button"]') || searchItems[0].closest('button');
      expect(searchButton).toHaveClass('Mui-disabled');
    });

    it('shows "Soon" badge on disabled items', () => {
      render(<SideNav {...defaultProps} />);

      // Search, People, Tags are disabled - each appears twice (mobile + desktop drawer)
      const soonBadges = screen.getAllByText('Soon');
      // 3 disabled items * 2 drawers = 6
      expect(soonBadges.length).toBe(6);
    });

    it('prevents click events on disabled items', () => {
      render(<SideNav {...defaultProps} />);

      const searchItems = screen.getAllByText('Search');
      const searchButton = searchItems[0].closest('div[role="button"]') || searchItems[0].closest('button');
      fireEvent.click(searchButton!);

      expect(mockNavigate).not.toHaveBeenCalledWith('/search');
    });
  });

  describe('mobile drawer', () => {
    beforeEach(() => {
      mockUseMediaQuery.mockReturnValue(true); // Mobile
    });

    it('renders drawer content on mobile', () => {
      render(<SideNav {...defaultProps} mobileOpen={true} />);

      const allMediaItems = screen.getAllByText('All Media');
      expect(allMediaItems.length).toBeGreaterThan(0);
    });

    it('calls onClose when navigation occurs on mobile', () => {
      const onClose = vi.fn();

      render(<SideNav {...defaultProps} mobileOpen={true} onClose={onClose} />);

      const allMediaItems = screen.getAllByText('All Media');
      const allMediaButton = allMediaItems[0].closest('div[role="button"]') || allMediaItems[0].closest('button');
      fireEvent.click(allMediaButton!);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('desktop drawer', () => {
    beforeEach(() => {
      mockUseMediaQuery.mockReturnValue(false); // Desktop
    });

    it('renders drawer content on desktop', () => {
      render(<SideNav {...defaultProps} />);

      const allMediaItems = screen.getAllByText('All Media');
      expect(allMediaItems.length).toBeGreaterThan(0);
    });

    it('does not call onClose on navigation (desktop)', () => {
      const onClose = vi.fn();

      render(<SideNav {...defaultProps} onClose={onClose} />);

      const allMediaItems = screen.getAllByText('All Media');
      const allMediaButton = allMediaItems[0].closest('div[role="button"]') || allMediaItems[0].closest('button');
      fireEvent.click(allMediaButton!);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('icons', () => {
    it('renders icon for All Media nav item', () => {
      render(<SideNav {...defaultProps} />);

      // MUI icons are rendered as SVGs within list items
      const allMediaItems = screen.getAllByText('All Media');
      const allMediaListItem = allMediaItems[0].closest('li');
      const svg = allMediaListItem?.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('renders icon for Settings nav item', () => {
      render(<SideNav {...defaultProps} />);

      const settingsItems = screen.getAllByText('Settings');
      const settingsListItem = settingsItems[0].closest('li');
      const svg = settingsListItem?.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('drawer structure', () => {
    it('renders navigation element', () => {
      render(<SideNav {...defaultProps} />);

      const nav = screen.getByRole('navigation');
      expect(nav).toBeInTheDocument();
    });
  });
});
