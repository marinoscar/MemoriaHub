import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute, OAuthCallback, AdminRoute } from '../components/auth';
import { AppLayout } from '../components/layout';
import {
  AdminSettingsPage,
  LoginPage,
  ProfilePage,
  SettingsPage,
  NotFoundPage,
  LibrariesPage,
  LibraryGalleryPage,
} from '../pages';
import { AllMediaPage } from '../pages/AllMediaPage';

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
        {/* Redirect home to All Media */}
        <Route index element={<Navigate to="/media" replace />} />

        {/* All Media page (landing page) */}
        <Route path="media" element={<AllMediaPage />} />

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

        {/* Libraries routes */}
        <Route path="libraries" element={<LibrariesPage />} />
        <Route path="libraries/:libraryId" element={<LibraryGalleryPage />} />

        {/* Future routes (placeholders) */}
        <Route path="search" element={<div>Search (Coming Soon)</div>} />
        <Route path="people" element={<div>People (Coming Soon)</div>} />
        <Route path="tags" element={<div>Tags (Coming Soon)</div>} />
      </Route>

      {/* 404 */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
