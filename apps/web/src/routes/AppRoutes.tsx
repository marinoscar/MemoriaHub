import { Routes, Route } from 'react-router-dom';
import { ProtectedRoute, OAuthCallback, AdminRoute } from '../components/auth';
import { AppLayout } from '../components/layout';
import {
  AdminSettingsPage,
  LoginPage,
  HomePage,
  ProfilePage,
  SettingsPage,
  NotFoundPage,
} from '../pages';

/**
 * Application routes configuration
 */
export function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route
        path="/login"
        element={
          <ProtectedRoute requireAuth={false}>
            <LoginPage />
          </ProtectedRoute>
        }
      />

      {/* OAuth callback */}
      <Route path="/auth/callback" element={<OAuthCallback />} />

      {/* Protected routes with layout */}
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />

        {/* Admin routes */}
        <Route
          path="admin"
          element={
            <AdminRoute>
              <AdminSettingsPage />
            </AdminRoute>
          }
        />

        {/* Future routes (placeholders) */}
        <Route path="libraries" element={<div>Libraries (Coming Soon)</div>} />
        <Route path="search" element={<div>Search (Coming Soon)</div>} />
        <Route path="people" element={<div>People (Coming Soon)</div>} />
        <Route path="tags" element={<div>Tags (Coming Soon)</div>} />
      </Route>

      {/* 404 */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
