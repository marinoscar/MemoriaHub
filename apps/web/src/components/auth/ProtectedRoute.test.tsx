/**
 * ProtectedRoute Component Tests
 *
 * Tests for route protection and auth-based redirects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../test/utils';
import { ProtectedRoute } from './ProtectedRoute';

// Mock useAuth hook
let mockAuthState = {
  isAuthenticated: false,
  isLoading: true,
};

vi.mock('../../hooks', () => ({
  useAuth: () => mockAuthState,
}));

// Mock react-router-dom Navigate component
const mockNavigate = vi.fn();
let mockLocationState: { from?: { pathname: string } } = {};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to, state }: { to: string; state?: unknown }) => {
      mockNavigate(to, state);
      return <div data-testid="navigate" data-to={to} />;
    },
    useLocation: () => ({
      pathname: '/current-path',
      state: mockLocationState,
    }),
  };
});

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState = {
      isAuthenticated: false,
      isLoading: true,
    };
    mockLocationState = {};
  });

  describe('loading state', () => {
    it('shows LoadingSpinner when isLoading is true', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: true,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('does not render children when loading', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: true,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });
  });

  describe('unauthenticated user', () => {
    it('redirects to /login when not authenticated', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/login');
    });

    it('does not render children when not authenticated', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('preserves intended destination in state', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(mockNavigate).toHaveBeenCalledWith(
        '/login',
        expect.objectContaining({
          from: expect.objectContaining({
            pathname: '/current-path',
          }),
        })
      );
    });

    it('uses custom redirect path when provided', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: false,
      };

      render(
        <ProtectedRoute redirectTo="/custom-login">
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/custom-login');
    });
  });

  describe('authenticated user', () => {
    it('renders children when authenticated', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.getByText('Protected Content')).toBeInTheDocument();
    });

    it('does not redirect when authenticated', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
    });

    it('does not show loading spinner when authenticated', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };

      render(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      );

      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('login page redirect (requireAuth=false)', () => {
    it('redirects authenticated user from login page to /', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };

      render(
        <ProtectedRoute requireAuth={false}>
          <div>Login Page</div>
        </ProtectedRoute>
      );

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/');
    });

    it('redirects to original destination if stored in state', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };
      mockLocationState = {
        from: { pathname: '/dashboard' },
      };

      render(
        <ProtectedRoute requireAuth={false}>
          <div>Login Page</div>
        </ProtectedRoute>
      );

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/dashboard');
    });

    it('allows unauthenticated user to view login page', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: false,
      };

      render(
        <ProtectedRoute requireAuth={false}>
          <div>Login Page</div>
        </ProtectedRoute>
      );

      expect(screen.getByText('Login Page')).toBeInTheDocument();
      expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
    });

    it('shows loading state on login page too', () => {
      mockAuthState = {
        isAuthenticated: false,
        isLoading: true,
      };

      render(
        <ProtectedRoute requireAuth={false}>
          <div>Login Page</div>
        </ProtectedRoute>
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('handles undefined location state gracefully', () => {
      mockAuthState = {
        isAuthenticated: true,
        isLoading: false,
      };
      mockLocationState = {};

      render(
        <ProtectedRoute requireAuth={false}>
          <div>Login Page</div>
        </ProtectedRoute>
      );

      // Should fall back to '/' when no from state
      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/');
    });
  });
});
