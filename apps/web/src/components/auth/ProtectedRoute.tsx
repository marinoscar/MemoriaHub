import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks';
import { LoadingSpinner } from '../common';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Whether authentication is required (default: true) */
  requireAuth?: boolean;
  /** Redirect path if not authenticated (default: /login) */
  redirectTo?: string;
}

/**
 * Protected route component
 * Redirects to login if not authenticated
 */
export function ProtectedRoute({
  children,
  requireAuth = true,
  redirectTo = '/login',
}: ProtectedRouteProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  // Show loading while checking auth
  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  // Redirect if auth required but not authenticated
  if (requireAuth && !isAuthenticated) {
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  // Redirect authenticated users away from login page
  if (!requireAuth && isAuthenticated) {
    const from = (location.state as { from?: Location })?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
}
