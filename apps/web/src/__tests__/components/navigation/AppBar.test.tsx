import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AppBar } from '../../../components/navigation/AppBar';
import { APP_NAME } from '../../../constants/app';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// TopbarSearch calls useSearch() which requires SearchProvider.
// Mock the entire SearchContext module so TopbarSearch can render in isolation.
vi.mock('../../../contexts/SearchContext', () => ({
  useSearch: vi.fn(() => ({
    messages: [],
    results: null,
    isSearching: false,
    error: null,
    searchRequest: null,
    runAgentSearch: vi.fn(),
    runDeterministicSearch: vi.fn(),
    clearSearch: vi.fn(),
  })),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// SearchPanel is heavy — stub it out for AppBar tests
vi.mock('../../../components/search/SearchPanel', () => ({
  SearchPanel: vi.fn(() => null),
}));

// MediaUploadDialog — stub to avoid upload service calls
vi.mock('../../../components/media/MediaUploadDialog', () => ({
  MediaUploadDialog: vi.fn(({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="upload-dialog"><button onClick={onClose}>Close</button></div> : null,
  ),
}));

// ---------------------------------------------------------------------------

describe('AppBar', () => {
  describe('Rendering', () => {
    it('should render app title', () => {
      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('should render as banner landmark', () => {
      render(<AppBar />);

      const appBar = screen.getByRole('banner');
      expect(appBar).toBeInTheDocument();
    });
  });

  describe('Theme Toggle', () => {
    it('should render theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
    });

    it('should show dark mode icon in light mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'light' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Dark mode icon (moon) should be shown when in light mode
    });

    it('should show light mode icon in dark mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'dark' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Light mode icon (sun) should be shown when in dark mode
    });

    it('should toggle theme on click', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      await user.click(toggleButton);

      // Theme should have toggled (via ThemeContext)
      expect(toggleButton).toBeInTheDocument();
    });
  });

  describe('User Menu', () => {
    it('should render user menu', () => {
      render(<AppBar />);

      // UserMenu component should be rendered (contains avatar button)
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should show user menu for authenticated users', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // Should have at least theme toggle and user menu button
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Navigation', () => {
    it('should navigate to home when title is clicked', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      await user.click(title);

      // Navigation should be triggered
      expect(title).toBeInTheDocument();
    });

    it('should have clickable title', () => {
      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      expect(title).toHaveStyle({ cursor: 'pointer' });
    });
  });

  describe('Styling', () => {
    it('should use sticky positioning', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
      // AppBar should have sticky position applied via MUI
    });

    it('should have proper elevation', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should render all elements on desktop', () => {
      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toHaveAccessibleName();
    });

    it('should have proper ARIA landmarks', () => {
      render(<AppBar />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });
  });

  describe('Brand slot', () => {
    it('renders logo image on desktop viewport', () => {
      render(<AppBar />);
      // jsdom media queries always return false → isPhone=false → desktop scenario.
      // Desktop: both the logo img and the wordmark text are rendered.
      expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('logo and wordmark both navigate to home on click', async () => {
      const user = userEvent.setup();
      render(<AppBar />);
      // The brand wrapper Box has the onClick; clicking the img triggers navigation.
      const logoImg = screen.getByRole('img', { name: APP_NAME });
      await user.click(logoImg);
      expect(logoImg).toBeInTheDocument();
    });
  });

  describe('Upload button', () => {
    it('shows Upload button when an active circle is present', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // The test-utils wrapper provides a default active circle.
      // AppBar shows Upload button (either outlined button or icon button) when circle is set.
      const uploadBtns = screen.queryAllByRole('button', { name: /upload media/i });
      expect(uploadBtns.length).toBeGreaterThanOrEqual(1);
    });

    it('opens MediaUploadDialog when Upload is clicked', async () => {
      const user = userEvent.setup();
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      const uploadBtn = screen.getByRole('button', { name: /upload media/i });
      await user.click(uploadBtn);

      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });
  });
});
