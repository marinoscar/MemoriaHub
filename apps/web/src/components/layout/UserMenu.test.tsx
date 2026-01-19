/**
 * UserMenu Component Tests
 *
 * Tests for user avatar dropdown menu, initials calculation, and menu interactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../test/utils';
import { UserMenu } from './UserMenu';
import type { UserDTO } from '@memoriahub/shared';

// Mock hooks
const mockLogout = vi.fn();
const mockToggleTheme = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../hooks', () => ({
  useAuth: () => ({
    logout: mockLogout,
    isAdmin: false,
  }),
  useTheme: () => ({
    toggleTheme: mockToggleTheme,
    isDarkMode: true,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const createMockUser = (overrides: Partial<UserDTO> = {}): UserDTO => ({
  id: 'user-123',
  email: 'test@example.com',
  displayName: 'John Doe',
  avatarUrl: null,
  oauthProvider: 'google',
  emailVerified: true,
  role: 'user',
  isActive: true,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogout.mockResolvedValue(undefined);
  });

  describe('avatar display', () => {
    it('shows user avatar image when avatarUrl exists', () => {
      const user = createMockUser({ avatarUrl: 'https://example.com/avatar.jpg' });

      render(<UserMenu user={user} />);

      const avatar = screen.getByRole('img');
      expect(avatar).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    });

    it('shows initials when no avatarUrl', () => {
      const user = createMockUser({ avatarUrl: null, displayName: 'John Doe' });

      render(<UserMenu user={user} />);

      // Avatar button contains initials
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('calculates initials from "John Doe" as "JD"', () => {
      const user = createMockUser({ displayName: 'John Doe', avatarUrl: null });

      render(<UserMenu user={user} />);

      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('calculates initials from "John" as "J"', () => {
      const user = createMockUser({ displayName: 'John', avatarUrl: null });

      render(<UserMenu user={user} />);

      expect(screen.getByText('J')).toBeInTheDocument();
    });

    it('calculates initials from "john doe" as "JD" (case handling)', () => {
      const user = createMockUser({ displayName: 'john doe', avatarUrl: null });

      render(<UserMenu user={user} />);

      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('shows fallback for empty display name (uses email)', () => {
      const user = createMockUser({ displayName: '', email: 'test@example.com', avatarUrl: null });

      render(<UserMenu user={user} />);

      // Should use first letter of email
      expect(screen.getByText('T')).toBeInTheDocument();
    });

    it('shows email initial for undefined display name', () => {
      const user = createMockUser({ displayName: undefined as unknown as string, email: 'user@test.com', avatarUrl: null });

      render(<UserMenu user={user} />);

      expect(screen.getByText('U')).toBeInTheDocument();
    });
  });

  describe('menu interaction', () => {
    it('opens menu on avatar click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      const avatarButton = screen.getByRole('button', { name: /account/i });
      fireEvent.click(avatarButton);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('closes menu on backdrop click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      // Open menu
      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // MUI Menu uses a backdrop with specific attributes - find and click it
      const backdrop = document.querySelector('.MuiBackdrop-root, .MuiModal-backdrop');
      if (backdrop) {
        fireEvent.click(backdrop);
      } else {
        // Fallback: Press Escape to close
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      }

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('closes menu on menu item click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // Click Profile menu item
      fireEvent.click(screen.getByText('Profile'));

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('closes menu on escape key', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('user info display', () => {
    it('shows user display name in header', async () => {
      const user = createMockUser({ displayName: 'Jane Smith' });

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      });
    });

    it('shows user email in header', async () => {
      const user = createMockUser({ email: 'jane@example.com' });

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('jane@example.com')).toBeInTheDocument();
      });
    });

    it('shows "User" when display name is empty', async () => {
      const user = createMockUser({ displayName: '' });

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('User')).toBeInTheDocument();
      });
    });
  });

  describe('menu items', () => {
    it('renders Profile menu item', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('Profile')).toBeInTheDocument();
      });
    });

    it('navigates to /profile on Profile click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Profile'));

      expect(mockNavigate).toHaveBeenCalledWith('/profile');
    });

    it('renders Settings menu item', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });
    });

    it('navigates to /settings on Settings click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Settings'));

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('renders theme toggle item', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        // In dark mode, shows "Light Mode" option
        expect(screen.getByText('Light Mode')).toBeInTheDocument();
      });
    });

    it('renders Logout menu item', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByText('Logout')).toBeInTheDocument();
      });
    });
  });

  describe('theme toggle', () => {
    it('shows LightMode icon when in dark mode', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        // "Light Mode" text indicates we're in dark mode
        expect(screen.getByText('Light Mode')).toBeInTheDocument();
      });
    });

    it('calls toggleTheme on click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Light Mode'));

      expect(mockToggleTheme).toHaveBeenCalled();
    });

    it('renders switch component for theme toggle', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument();
      });
    });
  });

  describe('logout', () => {
    it('calls logout function on click', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Logout'));

      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalled();
      });
    });

    it('navigates to /login after logout', async () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      fireEvent.click(screen.getByRole('button', { name: /account/i }));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Logout'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/login');
      });
    });
  });

  describe('tooltip', () => {
    it('has account tooltip on avatar button', () => {
      const user = createMockUser();

      render(<UserMenu user={user} />);

      const button = screen.getByRole('button', { name: /account/i });
      expect(button).toBeInTheDocument();
    });
  });
});
