/**
 * OAuthCallback Component Tests
 *
 * Tests for the OAuth callback handler that processes tokens from URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../test/utils';
import { OAuthCallback } from './OAuthCallback';

// Mock react-router-dom
const mockNavigate = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [mockSearchParams],
  };
});

// Mock useAuth hook
const mockLogin = vi.fn();

vi.mock('../../hooks', () => ({
  useAuth: () => ({
    login: mockLogin,
  }),
}));

describe('OAuthCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockLogin.mockReset();
    mockNavigate.mockReset();
  });

  describe('token extraction', () => {
    it('extracts access_token from URL search params', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      });
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(mockLogin).toHaveBeenCalledWith('test-access-token', 'test-refresh-token');
      });
    });

    it('extracts refresh_token from URL search params', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      });
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(mockLogin).toHaveBeenCalledWith('test-access-token', 'test-refresh-token');
      });
    });

    it('handles URL-encoded tokens', async () => {
      // When URLSearchParams is initialized from a URL query string, it decodes values
      // Use the constructor with a query string to simulate real URL behavior
      mockSearchParams = new URLSearchParams('access_token=token%2Bwith%2Bspecial%3Dchars&refresh_token=refresh-token');
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        // URLSearchParams automatically decodes URL-encoded values
        expect(mockLogin).toHaveBeenCalledWith('token+with+special=chars', 'refresh-token');
      });
    });
  });

  describe('successful login', () => {
    it('calls login with extracted tokens', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'my-access-token',
        refresh_token: 'my-refresh-token',
      });
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(mockLogin).toHaveBeenCalledWith('my-access-token', 'my-refresh-token');
      });
    });

    it('navigates to home page on success', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
      });
    });
  });

  describe('error handling', () => {
    it('displays error when error param in URL', async () => {
      mockSearchParams = new URLSearchParams({
        error: 'access_denied',
      });

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('access_denied')).toBeInTheDocument();
      });
    });

    it('displays error when access_token missing', async () => {
      mockSearchParams = new URLSearchParams({
        refresh_token: 'refresh-token',
      });

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('Missing authentication tokens')).toBeInTheDocument();
      });
    });

    it('displays error when refresh_token missing', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
      });

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('Missing authentication tokens')).toBeInTheDocument();
      });
    });

    it('displays error when login fails', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      mockLogin.mockRejectedValue(new Error('Login failed'));

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('Login failed')).toBeInTheDocument();
      });
    });

    it('shows login link on error', async () => {
      mockSearchParams = new URLSearchParams({
        error: 'access_denied',
      });

      render(<OAuthCallback />);

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /try again/i });
        expect(link).toBeInTheDocument();
        expect(link).toHaveAttribute('href', '/login');
      });
    });
  });

  describe('loading state', () => {
    it('shows loading spinner initially', () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      // Don't resolve login to keep loading state
      mockLogin.mockImplementation(() => new Promise(() => {}));

      render(<OAuthCallback />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows signing in message while loading', () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      mockLogin.mockImplementation(() => new Promise(() => {}));

      render(<OAuthCallback />);

      expect(screen.getByText(/signing you in/i)).toBeInTheDocument();
    });

    it('hides spinner after login attempt completes', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      mockLogin.mockResolvedValue(undefined);

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalled();
      });
    });

    it('hides spinner and shows error on failure', async () => {
      mockSearchParams = new URLSearchParams({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      mockLogin.mockRejectedValue(new Error('Failed'));

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('Failed')).toBeInTheDocument();
      });
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('does not call login when error in URL', () => {
    it('does not attempt login if error param present', async () => {
      mockSearchParams = new URLSearchParams({
        error: 'access_denied',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });

      render(<OAuthCallback />);

      await waitFor(() => {
        expect(screen.getByText('access_denied')).toBeInTheDocument();
      });

      expect(mockLogin).not.toHaveBeenCalled();
    });
  });
});
