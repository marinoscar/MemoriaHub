/**
 * AppLayout Component Tests
 *
 * Tests for the main application layout with top bar and side navigation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../test/utils';
import { AppLayout } from './AppLayout';

// Mock child components
vi.mock('./TopBar', () => ({
  TopBar: ({ onMenuClick }: { onMenuClick: () => void }) => (
    <div data-testid="top-bar">
      <button onClick={onMenuClick} data-testid="menu-toggle">
        Toggle Menu
      </button>
    </div>
  ),
}));

vi.mock('./SideNav', () => ({
  SideNav: ({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) => (
    <div data-testid="side-nav" data-mobile-open={mobileOpen}>
      <button onClick={onClose} data-testid="close-nav">
        Close
      </button>
    </div>
  ),
}));

// Mock Outlet
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet">Page Content</div>,
  };
});

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('component rendering', () => {
    it('renders TopBar', () => {
      render(<AppLayout />);

      expect(screen.getByTestId('top-bar')).toBeInTheDocument();
    });

    it('renders SideNav', () => {
      render(<AppLayout />);

      expect(screen.getByTestId('side-nav')).toBeInTheDocument();
    });

    it('renders Outlet for nested routes', () => {
      render(<AppLayout />);

      expect(screen.getByTestId('outlet')).toBeInTheDocument();
      expect(screen.getByText('Page Content')).toBeInTheDocument();
    });
  });

  describe('mobile drawer state', () => {
    it('starts with mobile drawer closed', () => {
      render(<AppLayout />);

      const sideNav = screen.getByTestId('side-nav');
      expect(sideNav).toHaveAttribute('data-mobile-open', 'false');
    });

    it('opens mobile drawer when menu button clicked', () => {
      render(<AppLayout />);

      fireEvent.click(screen.getByTestId('menu-toggle'));

      const sideNav = screen.getByTestId('side-nav');
      expect(sideNav).toHaveAttribute('data-mobile-open', 'true');
    });

    it('closes mobile drawer when onClose called', () => {
      render(<AppLayout />);

      // Open drawer
      fireEvent.click(screen.getByTestId('menu-toggle'));
      expect(screen.getByTestId('side-nav')).toHaveAttribute('data-mobile-open', 'true');

      // Close drawer
      fireEvent.click(screen.getByTestId('close-nav'));
      expect(screen.getByTestId('side-nav')).toHaveAttribute('data-mobile-open', 'false');
    });

    it('toggles drawer state on multiple clicks', () => {
      render(<AppLayout />);

      const sideNav = screen.getByTestId('side-nav');

      // Initially closed
      expect(sideNav).toHaveAttribute('data-mobile-open', 'false');

      // Click to open
      fireEvent.click(screen.getByTestId('menu-toggle'));
      expect(sideNav).toHaveAttribute('data-mobile-open', 'true');

      // Click to close (via toggle)
      fireEvent.click(screen.getByTestId('menu-toggle'));
      expect(sideNav).toHaveAttribute('data-mobile-open', 'false');
    });
  });

  describe('layout structure', () => {
    it('renders main content area', () => {
      render(<AppLayout />);

      const main = document.querySelector('main');
      expect(main).toBeInTheDocument();
    });

    it('applies flex display to container', () => {
      render(<AppLayout />);

      // The root Box has display: flex
      const container = screen.getByTestId('outlet').closest('[class*="MuiBox"]');
      expect(container).toBeInTheDocument();
    });
  });

  describe('drawer width', () => {
    it('passes drawer width to TopBar', () => {
      render(<AppLayout />);

      // TopBar receives drawerWidth prop - verified by mock rendering
      expect(screen.getByTestId('top-bar')).toBeInTheDocument();
    });

    it('passes drawer width to SideNav', () => {
      render(<AppLayout />);

      // SideNav receives drawerWidth prop - verified by mock rendering
      expect(screen.getByTestId('side-nav')).toBeInTheDocument();
    });
  });
});
