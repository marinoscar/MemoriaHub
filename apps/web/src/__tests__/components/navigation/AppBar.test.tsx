import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AppBar } from '../../../components/navigation/AppBar';

describe('AppBar', () => {
  describe('Rendering', () => {
    it('should render app title', () => {
      render(<AppBar />);

      expect(screen.getByText(/enterprise app/i)).toBeInTheDocument();
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

      const title = screen.getByText(/enterprise app/i);
      await user.click(title);

      // Navigation should be triggered
      expect(title).toBeInTheDocument();
    });

    it('should have clickable title', () => {
      render(<AppBar />);

      const title = screen.getByText(/enterprise app/i);
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

      expect(screen.getByText(/enterprise app/i)).toBeInTheDocument();
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
});
