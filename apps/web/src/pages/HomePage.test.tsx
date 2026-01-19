/**
 * HomePage Component Tests
 *
 * Tests for the dashboard/home page rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../test/utils';
import { HomePage } from './HomePage';
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
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('HomePage', () => {
  describe('greeting', () => {
    it('renders personalized greeting with user first name', () => {
      mockUser = createMockUser({ displayName: 'John Doe' });

      render(<HomePage />);

      expect(screen.getByText(/Welcome, John!/)).toBeInTheDocument();
    });

    it('renders generic greeting when user has no display name', () => {
      mockUser = createMockUser({ displayName: '' });

      render(<HomePage />);

      expect(screen.getByText('Welcome!')).toBeInTheDocument();
    });

    it('renders generic greeting when user is null', () => {
      mockUser = null;

      render(<HomePage />);

      expect(screen.getByText('Welcome!')).toBeInTheDocument();
    });

    it('handles single-word display names', () => {
      mockUser = createMockUser({ displayName: 'Jane' });

      render(<HomePage />);

      expect(screen.getByText(/Welcome, Jane!/)).toBeInTheDocument();
    });
  });

  describe('feature cards', () => {
    beforeEach(() => {
      mockUser = createMockUser();
    });

    it('renders Libraries feature card', () => {
      render(<HomePage />);

      expect(screen.getByText('Libraries')).toBeInTheDocument();
    });

    it('renders Upload feature card', () => {
      render(<HomePage />);

      expect(screen.getByText('Upload')).toBeInTheDocument();
    });

    it('renders Search feature card', () => {
      render(<HomePage />);

      expect(screen.getByText('Search')).toBeInTheDocument();
    });

    it('renders People feature card', () => {
      render(<HomePage />);

      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('shows "Coming Soon" badges on disabled features', () => {
      render(<HomePage />);

      const comingSoonBadges = screen.getAllByText('Coming Soon');
      expect(comingSoonBadges.length).toBe(4); // All 4 features are disabled
    });

    it('renders feature descriptions', () => {
      render(<HomePage />);

      expect(
        screen.getByText(/Create and organize photo libraries/)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Upload photos via WebDAV/)
      ).toBeInTheDocument();
    });
  });

  describe('getting started section', () => {
    beforeEach(() => {
      mockUser = createMockUser();
    });

    it('renders getting started heading', () => {
      render(<HomePage />);

      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    it('renders development notice', () => {
      render(<HomePage />);

      expect(
        screen.getByText(/MemoriaHub is currently in development/)
      ).toBeInTheDocument();
    });

    it('renders feature list', () => {
      render(<HomePage />);

      expect(screen.getByText(/Library creation and management/)).toBeInTheDocument();
      expect(screen.getByText(/WebDAV upload support/)).toBeInTheDocument();
      expect(screen.getByText(/AI-powered search/)).toBeInTheDocument();
    });
  });

  describe('platform description', () => {
    beforeEach(() => {
      mockUser = createMockUser();
    });

    it('renders platform description', () => {
      render(<HomePage />);

      expect(
        screen.getByText(/privacy-first platform for organizing/)
      ).toBeInTheDocument();
    });
  });
});
