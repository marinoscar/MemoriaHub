import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks';
import { LoadingSpinner } from '../common';

interface AdminRouteProps {
  children: React.ReactNode;
  /** Redirect path if not admin (default: /) */
  redirectTo?: string;
}

/**
 * Protected route that requires admin role
 * Redirects non-admin users to home page
 * Redirects unauthenticated users to login page
 */
export function AdminRoute({
  children,
  redirectTo = '/',
}: AdminRouteProps) {
  const { isAuthenticated, isLoading, isAdmin } = useAuth();
  const location = useLocation();

  // Show loading while checking auth
  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Redirect if not admin
  if (!isAdmin) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}
