import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { CircleProvider } from './contexts/CircleContext';
import { ThemeContextProvider, useThemeContext } from './contexts/ThemeContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { Layout } from './components/common/Layout';
import { ErrorBoundary } from './components/common/ErrorBoundary';

// Pages (lazy loaded)
import { Suspense, lazy } from 'react';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage'));
const ActivateDevicePage = lazy(() => import('./pages/ActivateDevicePage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const UserSettingsPage = lazy(() => import('./pages/UserSettingsPage'));
const SystemSettingsPage = lazy(() => import('./pages/SystemSettingsPage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const MediaLibraryPage = lazy(() => import('./pages/MediaLibrary'));
const MediaMapPage = lazy(() => import('./pages/MediaMapPage'));
const CircleListPage = lazy(() => import('./pages/Circles/CircleListPage'));
const CircleDetailPage = lazy(() => import('./pages/Circles/CircleDetailPage'));
const BackupPage = lazy(() => import('./pages/Admin/BackupPage'));
const AiSettingsPage = lazy(() => import('./pages/Admin/AiSettingsPage'));
const FaceSettingsPage = lazy(() => import('./pages/Admin/FaceSettingsPage'));
const JobsPage = lazy(() => import('./pages/Admin/JobsPage'));

const StorageInsightsPage = lazy(() => import('./pages/Admin/StorageInsightsPage'));
const StorageProvidersPage = lazy(() => import('./pages/Admin/StorageProvidersPage'));
const SettingsHubPage = lazy(() => import('./pages/Admin/SettingsHubPage'));
const TaggingSettingsPage = lazy(() => import('./pages/Admin/TaggingSettingsPage'));
const BurstsSettingsPage = lazy(() => import('./pages/Admin/BurstsSettingsPage'));
const GeoSettingsPage = lazy(() => import('./pages/Admin/GeoSettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const PeoplePage = lazy(() => import('./pages/People/PeoplePage'));
const AlbumsPage = lazy(() => import('./pages/Albums'));
const AlbumPage = lazy(() => import('./pages/Albums/AlbumPage'));
const TagsBrowsePage = lazy(() => import('./pages/Tags'));
const BurstsPage = lazy(() => import('./pages/Bursts/BurstsPage'));
const BurstGroupPage = lazy(() => import('./pages/Bursts/BurstGroupPage'));

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import('./pages/TestLoginPage'));

function AppRoutes() {
  const { theme } = useThemeContext();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner fullScreen />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />

            {/* Test login (development only) */}
            {!import.meta.env.PROD && TestLoginPage && (
              <Route path="/testing/login" element={<TestLoginPage />} />
            )}

            {/* Protected routes */}
            <Route element={<ProtectedRoute />}>
              {/* Device activation page - without layout for full-screen experience */}
              <Route path="/activate" element={<ActivateDevicePage />} />

              <Route element={<Layout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/settings" element={<UserSettingsPage />} />
                <Route path="/media" element={<MediaLibraryPage />} />
                <Route path="/map" element={<MediaMapPage />} />
                <Route path="/circles" element={<CircleListPage />} />
                <Route path="/circles/:id" element={<CircleDetailPage />} />
                {/* Settings Hub */}
                <Route path="/admin/settings" element={<SettingsHubPage />} />
                <Route path="/admin/settings/general" element={<SystemSettingsPage />} />
                <Route path="/admin/settings/users" element={<UserManagementPage />} />
                <Route path="/admin/settings/ai" element={<AiSettingsPage />} />
                <Route path="/admin/settings/tagging" element={<TaggingSettingsPage />} />
                <Route path="/admin/settings/face" element={<FaceSettingsPage />} />
                <Route path="/admin/settings/bursts" element={<BurstsSettingsPage />} />
                <Route path="/admin/settings/geo" element={<GeoSettingsPage />} />
                <Route path="/admin/settings/storage/providers" element={<StorageProvidersPage />} />
                <Route path="/admin/settings/storage/insights" element={<StorageInsightsPage />} />
                <Route path="/admin/settings/jobs" element={<JobsPage />} />
                <Route path="/admin/settings/backup" element={<BackupPage />} />
                {/* Legacy admin route redirects */}
                <Route path="/admin/users" element={<Navigate to="/admin/settings/users" replace />} />
                <Route path="/admin/ai-settings" element={<Navigate to="/admin/settings/ai" replace />} />
                <Route path="/admin/face-settings" element={<Navigate to="/admin/settings/face" replace />} />
                <Route path="/admin/jobs" element={<Navigate to="/admin/settings/jobs" replace />} />
                <Route path="/admin/tags" element={<Navigate to="/admin/settings/tagging" replace />} />
                <Route path="/admin/insights" element={<Navigate to="/admin/settings/storage/insights" replace />} />
                <Route path="/admin/storage-providers" element={<Navigate to="/admin/settings/storage/providers" replace />} />
                <Route path="/admin/backup" element={<Navigate to="/admin/settings/backup" replace />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/tags" element={<TagsBrowsePage />} />
                <Route path="/albums" element={<AlbumsPage />} />
                <Route path="/albums/:albumId" element={<AlbumPage />} />
                <Route path="/bursts" element={<BurstsPage />} />
                <Route path="/bursts/:id" element={<BurstGroupPage />} />
              </Route>
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ThemeContextProvider>
      <AuthProvider>
        <CircleProvider>
          <AppRoutes />
        </CircleProvider>
      </AuthProvider>
    </ThemeContextProvider>
  );
}
