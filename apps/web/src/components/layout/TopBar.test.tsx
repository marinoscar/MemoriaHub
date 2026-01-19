/**
 * TopBar Component Tests
 *
 * Tests for the app bar with logo and user menu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../test/utils';
import { TopBar } from './TopBar';
import type { UserDTO } from '@memoriahub/shared';

// Mock user data
let mockUser: UserDTO | null = null;
let mockIsAuthenticated = false;

vi.mock('../../hooks', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
  }),
  useLibraries: () => ({
    libraries: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Mock UserMenu
vi.mock('./UserMenu', () => ({
  UserMenu: ({ user }: { user: UserDTO }) => (
    <div data-testid="user-menu">{user.displayName}</div>
  ),
}));

// Mock UploadButton
vi.mock('../upload', () => ({
  UploadButton: () => <button data-testid="upload-button">Upload</button>,
}));

// Mock navigate
const mockNavigate = vi.fn();

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
  role: 'user',
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('TopBar', () => {
  const defaultProps = {
    onMenuClick: vi.fn(),
    drawerWidth: 240,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = null;
    mockIsAuthenticated = false;
  });

  describe('logo and title', () => {
    it('renders logo icon', () => {
      render(<TopBar {...defaultProps} />);

      // MUI PhotoLibrary icon is an SVG
      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('renders app title', () => {
      render(<TopBar {...defaultProps} />);

      expect(screen.getByText('MemoriaHub')).toBeInTheDocument();
    });

    it('navigates to home on logo/title click', () => {
      render(<TopBar {...defaultProps} />);

      fireEvent.click(screen.getByText('MemoriaHub'));

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  describe('menu button', () => {
    it('renders menu button', () => {
      render(<TopBar {...defaultProps} />);

      expect(screen.getByRole('button', { name: /open drawer/i })).toBeInTheDocument();
    });

    it('calls onMenuClick when menu button clicked', () => {
      const onMenuClick = vi.fn();

      render(<TopBar {...defaultProps} onMenuClick={onMenuClick} />);

      fireEvent.click(screen.getByRole('button', { name: /open drawer/i }));

      expect(onMenuClick).toHaveBeenCalled();
    });
  });

  describe('authenticated state', () => {
    it('renders UserMenu when authenticated', () => {
      mockIsAuthenticated = true;
      mockUser = createMockUser();

      render(<TopBar {...defaultProps} />);

      expect(screen.getByTestId('user-menu')).toBeInTheDocument();
    });

    it('passes user to UserMenu', () => {
      mockIsAuthenticated = true;
      mockUser = createMockUser({ displayName: 'Jane Smith' });

      render(<TopBar {...defaultProps} />);

      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    });
  });

  describe('unauthenticated state', () => {
    it('renders Sign In button when not authenticated', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<TopBar {...defaultProps} />);

      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });

    it('navigates to /login on Sign In click', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<TopBar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/login');
    });

    it('does not render UserMenu when not authenticated', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<TopBar {...defaultProps} />);

      expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
    });
  });

  describe('app bar styling', () => {
    it('renders as fixed position app bar', () => {
      render(<TopBar {...defaultProps} />);

      const appBar = document.querySelector('.MuiAppBar-root');
      expect(appBar).toBeInTheDocument();
    });
  });
});
