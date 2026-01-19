/**
 * ProfilePage Component Tests
 *
 * Tests for the user profile page rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../test/utils';
import { ProfilePage } from './ProfilePage';
import type { UserDTO } from '@memoriahub/shared';

// Mock user data
let mockUser: UserDTO | null = null;

vi.mock('../hooks', () => ({
  useAuth: () => ({
    user: mockUser,
  }),
}));

const createMockUser = (overrides: Partial<UserDTO> = {}): UserDTO => ({
  id: 'user-123',
  email: 'test@example.com',
  displayName: 'John Doe',
  avatarUrl: null,
  oauthProvider: 'google',
  emailVerified: true,
  role: 'user',
  isActive: true,
  createdAt: '2024-01-15T10:30:00Z',
  updatedAt: '2024-01-15T10:30:00Z',
  ...overrides,
});

describe('ProfilePage', () => {
  beforeEach(() => {
    mockUser = createMockUser();
  });

  describe('user avatar', () => {
    it('renders user avatar', () => {
      render(<ProfilePage />);

      // Avatar component is present
      expect(document.querySelector('.MuiAvatar-root')).toBeInTheDocument();
    });

    it('shows avatar image when avatarUrl exists', () => {
      mockUser = createMockUser({ avatarUrl: 'https://example.com/avatar.jpg' });

      render(<ProfilePage />);

      const avatar = screen.getByRole('img');
      expect(avatar).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    });

    it('calculates initials correctly from "John Doe"', () => {
      mockUser = createMockUser({ displayName: 'John Doe', avatarUrl: null });

      render(<ProfilePage />);

      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('calculates initials from single name', () => {
      mockUser = createMockUser({ displayName: 'Jane', avatarUrl: null });

      render(<ProfilePage />);

      expect(screen.getByText('J')).toBeInTheDocument();
    });

    it('uses email initial when no display name', () => {
      mockUser = createMockUser({ displayName: '', email: 'test@example.com', avatarUrl: null });

      render(<ProfilePage />);

      expect(screen.getByText('T')).toBeInTheDocument();
    });
  });

  describe('user info display', () => {
    it('renders user display name', () => {
      mockUser = createMockUser({ displayName: 'Jane Smith' });

      render(<ProfilePage />);

      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    });

    it('renders user email', () => {
      mockUser = createMockUser({ email: 'jane@example.com' });

      render(<ProfilePage />);

      // Email appears twice - once in header, once in details
      const emails = screen.getAllByText('jane@example.com');
      expect(emails.length).toBeGreaterThan(0);
    });

    it('shows "User" when display name is empty', () => {
      mockUser = createMockUser({ displayName: '' });

      render(<ProfilePage />);

      expect(screen.getByText('User')).toBeInTheDocument();
    });
  });

  describe('OAuth provider', () => {
    it('renders OAuth provider chip for Google', () => {
      mockUser = createMockUser({ oauthProvider: 'google' });

      render(<ProfilePage />);

      expect(screen.getByText('Signed in with Google')).toBeInTheDocument();
    });

    it('maps provider name correctly for Microsoft', () => {
      mockUser = createMockUser({ oauthProvider: 'microsoft' });

      render(<ProfilePage />);

      expect(screen.getByText('Signed in with Microsoft')).toBeInTheDocument();
    });

    it('maps provider name correctly for GitHub', () => {
      mockUser = createMockUser({ oauthProvider: 'github' });

      render(<ProfilePage />);

      expect(screen.getByText('Signed in with GitHub')).toBeInTheDocument();
    });

    it('shows raw provider name for unknown providers', () => {
      mockUser = createMockUser({ oauthProvider: 'custom' as UserDTO['oauthProvider'] });

      render(<ProfilePage />);

      expect(screen.getByText('Signed in with custom')).toBeInTheDocument();
    });
  });

  describe('account details', () => {
    it('renders account ID', () => {
      mockUser = createMockUser({ id: 'user-abc-123' });

      render(<ProfilePage />);

      expect(screen.getByText('user-abc-123')).toBeInTheDocument();
    });

    it('renders creation date formatted', () => {
      mockUser = createMockUser({ createdAt: '2024-03-15T10:30:00Z' });

      render(<ProfilePage />);

      // Date should be formatted like "March 15, 2024"
      expect(screen.getByText(/March 15, 2024/)).toBeInTheDocument();
    });

    it('shows "Not set" for missing display name', () => {
      mockUser = createMockUser({ displayName: '' });

      render(<ProfilePage />);

      expect(screen.getByText('Not set')).toBeInTheDocument();
    });
  });

  describe('page structure', () => {
    it('renders page title', () => {
      render(<ProfilePage />);

      expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    });

    it('renders Account Details section', () => {
      render(<ProfilePage />);

      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });

    it('renders section labels', () => {
      render(<ProfilePage />);

      expect(screen.getByText('User ID')).toBeInTheDocument();
      expect(screen.getByText('Email')).toBeInTheDocument();
      expect(screen.getByText('Display Name')).toBeInTheDocument();
      expect(screen.getByText('Account Created')).toBeInTheDocument();
    });
  });

  describe('no user', () => {
    it('returns null when user is null', () => {
      mockUser = null;

      const { container } = render(<ProfilePage />);

      expect(container.firstChild).toBeNull();
    });
  });
});
