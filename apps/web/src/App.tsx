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
const AdminCirclesPage = lazy(() => import('./pages/Admin/AdminCirclesPage'));
const BackupPage = lazy(() => import('./pages/Admin/BackupPage'));
const AiSettingsPage = lazy(() => import('./pages/Admin/AiSettingsPage'));
const FaceSettingsPage = lazy(() => import('./pages/Admin/FaceSettingsPage'));
const JobsPage = lazy(() => import('./pages/Admin/JobsPage'));
const TagsPage = lazy(() => import('./pages/Admin/TagsPage'));
const StorageInsightsPage = lazy(() => import('./pages/Admin/StorageInsightsPage'));
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
                <Route path="/admin/users" element={<UserManagementPage />} />
                <Route path="/admin/settings" element={<SystemSettingsPage />} />
                <Route path="/admin/circles" element={<AdminCirclesPage />} />
                <Route path="/admin/backup" element={<BackupPage />} />
                <Route path="/admin/ai-settings" element={<AiSettingsPage />} />
                <Route path="/admin/face-settings" element={<FaceSettingsPage />} />
                <Route path="/admin/jobs" element={<JobsPage />} />
                <Route path="/admin/tags" element={<TagsPage />} />
                <Route path="/admin/insights" element={<StorageInsightsPage />} />
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
