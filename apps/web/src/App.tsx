import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { OwnerScopeProvider } from './contexts/OwnerScopeContext';
import { MemoriahubHostBinding } from './platform-memoriahub/HostBinding';
// The packaged shell theme (RETRO-F1, #571): `ShellRoot` is the theme-mode
// provider plus MUI's ThemeProvider and CssBaseline, under the same
// `theme_mode` key.
import { ShellRoot } from '@marinoscar/platform-web/shell/ui';
import { THEME_STORAGE_KEY } from './contexts/ThemeContext';
import { APP_THEMES } from './theme';
import { Layout } from './components/common/Layout';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { RequirePermission } from './components/common/RequirePermission';
// The packaged host UI (RETRO-B1, #597): the maintenance gate that takes the
// application over while the API is refusing, and the PWA prompts. The two
// admin pages (About, Maintenance) are bound in pages/Admin.
import { InstallPrompt, MaintenanceGate, UpdatePrompt } from '@marinoscar/platform-web/host/ui';
// `virtual:pwa-register/react` exists only in this app's bundler (vite-plugin-pwa),
// so the packaged `UpdatePrompt` takes the hook as a prop.
import { useRegisterSW } from 'virtual:pwa-register/react';
import './platform/notifications';
import { AppPlatformHostProvider, appPlatformApi } from './platform/platformHost';
// The packaged identity UI (RETRO-B2, #611): sign-in, callback, device
// activation, access tokens, users and allowlist, behind the identity guards.
import { RequireAuth } from '@marinoscar/platform-web/identity/headless';
import {
  ActivateDevicePage,
  AuthCallbackPage,
  LoginPage,
  UserTokensPage,
  UsersPage,
} from '@marinoscar/platform-web/identity/ui';
import { IdentityWebAdaptersProvider } from '@marinoscar/platform-web/identity/headless';
import { appIdentityAdapters } from './platform/identityAdapters';
import { JobsWebAdaptersProvider } from '@marinoscar/platform-web/jobs/headless';
import { appJobsAdapters } from './platform/jobsAdapters';
import { appWorkersPageSlots } from './platform/nodesExtensions';
// The packaged telemetry slice (RETRO-T2, #625): the route guard, the adapters
// provider and this app's auth-gated binding of `GET /api/telemetry/config`.
import { RequireTelemetryEnabled, TelemetryWebAdaptersProvider } from '@marinoscar/platform-web/telemetry/headless';
import { appTelemetryAdapters } from './platform/telemetryAdapters';
import { RequireAiEnabled } from '@marinoscar/platform-web/ai/ui/require-ai-enabled';
import { AppTelemetryConfigProvider } from './platform/TelemetryConfigBinding';
import { APP_NAME } from './constants/app';

// Pages (lazy loaded)
import { Suspense, lazy } from 'react';
import type { ComponentType } from 'react';
import { LoadingSpinner } from './components/common/LoadingSpinner';

// The media pages are the packaged `media` slice's (`@marinoscar/memoriahub-web/media/ui`); each
// route lazy-loads the slice entry and picks its page, so the page stays out of the main chunk.
type MediaUiModule = typeof import('@marinoscar/memoriahub-web/media/ui');
const lazyMediaPage = <K extends keyof MediaUiModule>(name: K) =>
  lazy(() =>
    import('@marinoscar/memoriahub-web/media/ui').then((m) => ({
      default: m[name] as unknown as ComponentType<any>,
    })),
  );

const HomePage = lazy(() => import('./pages/HomePage'));
const UserSettingsHubPage = lazy(() => import('./pages/UserSettingsHubPage'));
const AppearanceSettingsPage = lazy(() => import('./pages/settings/AppearanceSettingsPage'));
const TimeZoneSettingsPage = lazy(() => import('./pages/settings/TimeZoneSettingsPage'));
const NotificationPreferencesPage = lazy(() => import('./pages/settings/NotificationPreferencesPage'));
const MemoriesPreferencesPage = lazy(() => import('./pages/settings/MemoriesPreferencesPage'));
const SearchPreferencesPage = lazy(() => import('./pages/settings/SearchPreferencesPage'));
const AndroidAppDownloadPage = lazy(() => import('./pages/AndroidAppDownloadPage'));
const MediaSyncPage = lazy(() => import('./pages/MediaSyncPage'));
const ProfilePage = lazy(() => import('./pages/Profile/ProfilePage'));
const SystemSettingsPage = lazy(() => import('./pages/SystemSettingsPage'));
const MediaLibraryPage = lazyMediaPage('MediaLibraryPage');
const MediaMapPage = lazyMediaPage('MediaMapPage');
// RETRO-I6 (#588): circles are platform groups; the packaged pages manage them.
const GroupsPage = lazy(() =>
  import('@marinoscar/platform-web/sharing/ui').then((module) => ({ default: module.GroupsPage })),
);
const GroupDetailPage = lazy(() =>
  import('@marinoscar/platform-web/sharing/ui').then((module) => ({ default: module.GroupDetailPage })),
);
const LegacyCircleRedirect = lazy(() => import('./pages/LegacyCircleRedirect'));
const DbBackupPage = lazy(() => import('./platform/db-backup/DbBackupPage'));
// RETRO-H1 (#591): the platform user-data slice's two pages. The Danger Zone deletes the
// caller's own data (`/api/user-data/*`, `user_settings:write`, every role); the factory
// reset wipes the deployment (`system:factory_reset`, Admin only).
const UserDangerZonePage = lazy(() =>
  import('@marinoscar/platform-web/user-data/ui').then((m) => ({ default: m.UserDangerZonePage })),
);
const FactoryResetPage = lazy(() =>
  import('@marinoscar/platform-web/user-data/ui').then((m) => ({ default: m.FactoryResetPage })),
);
// RETRO-H2 (#596): the exports slice's "Download your data" page (`/api/exports`): every source
// the caller may use (the platform's `user-data`, `org-data` for `org_members:read`, and
// MemoriaHub's media, albums, memories and people), the request dialog and the recent exports.
const DataExportPage = lazy(() =>
  import('@marinoscar/platform-web/exports/ui').then((m) => ({ default: m.DataExportPage })),
);
// RETRO-E4 (#607): the platform's admin AI pages, each a thin binding (`platform/ai/`); the
// MemoriaHub feature selections ride in the AI page's `Sections` slot.
const AiConfigRoute = lazy(() => import('./platform/ai/AiConfigRoute'));
const AiModelsRoute = lazy(() => import('./platform/ai/AiModelsRoute'));
const AiUsageRoute = lazy(() => import('./platform/ai/AiUsageRoute'));
const FaceSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/face/ui').then((m) => ({ default: m.FaceSettingsPage })));
const GeoSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/location/ui').then((m) => ({ default: m.GeoSettingsPage })));
// The platform's email settings page (RETRO-D2, #570): transports, sender, write-only secrets and the
// test send to the caller's own address (`@marinoscar/platform-web/email/ui`).
const EmailSettingsPage = lazy(() =>
  import('@marinoscar/platform-web/email/ui').then((m) => ({ default: m.EmailSettingsPage })),
);
// RETRO-D3 (#576): the notifications slice's admin pages.
const PushConfigPage = lazy(() =>
  import('@marinoscar/platform-web/notifications/ui').then((m) => ({ default: m.PushConfigPage })),
);
const NotificationPolicyPage = lazy(() =>
  import('@marinoscar/platform-web/notifications/ui').then((m) => ({ default: m.NotificationSettingsPage })),
);
const BroadcastsPage = lazy(() =>
  import('@marinoscar/platform-web/notifications/ui').then((m) => ({ default: m.BroadcastsPage })),
);
// RETRO-H3 (#599): the onboarding slice's two pages (`@marinoscar/platform-web/onboarding/ui`).
const SetupGuidePage = lazy(() => import('./platform/onboarding/SetupGuideRoute'));
const GettingStartedPage = lazy(() => import('./platform/onboarding/GettingStartedRoute'));
const AndroidAppPage = lazy(() => import('./platform/android-app/AndroidAppPage'));
// The platform's Jobs and Job Insights pages (RETRO-C1, #575); the Jobs one is a thin binding that adds
// the app's "Repair missing thumbnails" action to the page toolbar.
const JobsPage = lazy(() => import('./pages/Admin/JobsPage'));
const JobInsightsPage = lazy(() =>
  import('@marinoscar/platform-web/jobs/ui').then((m) => ({ default: m.JobInsightsPage })),
);
// RETRO-C2 (#581): the packaged Worker Nodes page (`nodes:read`), with the app's row action.
const WorkersPage = lazy(() => import('@marinoscar/platform-web/nodes/ui').then((m) => ({ default: m.WorkersPage })));
const NodeBackupPage = lazy(() => import('./pages/Admin/NodeBackupPage'));
const DoctorPage = lazy(() => import('./pages/Admin/DoctorPage'));
// RETRO-B1 (#597): the platform host's two admin pages, packaged. Lazy like
// every other admin page: nobody who never opens the Console needs them in the
// entry chunk.
const AdminMaintenancePage = lazy(() => import('./pages/Admin/MaintenancePage'));
const AboutPage = lazy(() => import('./pages/Admin/AboutPage'));
const WorkflowsSettingsPage = lazy(() =>
  import('@marinoscar/memoriahub-web/workflows/ui').then((m) => ({ default: m.WorkflowsSettingsPage })),
);
const StorageInsightsPage = lazy(() => import('./pages/Admin/StorageInsightsPage'));
const StorageConfigPage = lazy(() => import('./platform/storage/StorageConfigPage'));
const SettingsHubPage = lazy(() => import('./pages/Admin/SettingsHubPage'));
// RETRO-J11 (#626): the packaged Tagging settings page (vocabulary included); the host supplies its table, header and settings hook.
const TaggingSettingsPage = lazy(() =>
  import('@marinoscar/memoriahub-web/tagging/ui').then((m) => ({ default: m.TaggingSettingsPage })),
);
const BurstsSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.BurstsSettingsPage })));
const DuplicatesSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.DuplicatesSettingsPage })));
const SocialMediaSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/social/ui').then((m) => ({ default: m.SocialMediaSettingsPage })));
const EnhancerSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/enhancement/ui').then((m) => ({ default: m.EnhancerSettingsPage })));
const MemoriesSettingsPage = lazy(() =>
  import('@marinoscar/memoriahub-web/memories/ui').then((m) => ({ default: m.MemoriesSettingsPage })),
);
const LocationInferenceSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.LocationInferenceSettingsPage })));
const LocationGroupsSettingsPage = lazy(() => import('@marinoscar/memoriahub-web/location/ui').then((m) => ({ default: m.LocationGroupsSettingsPage })));
const ArchivingSettingsPage = lazy(() => import('./pages/Admin/ArchivingSettingsPage'));
const SearchPage = lazy(() =>
  import('@marinoscar/memoriahub-web/search/ui').then((m) => ({ default: m.SearchPage })),
);
const PeoplePage = lazy(() => import('@marinoscar/memoriahub-web/people/ui').then((m) => ({ default: m.PeoplePage })));
const ArchivedFacesPage = lazy(() => import('@marinoscar/memoriahub-web/people/ui').then((m) => ({ default: m.ArchivedFacesPage })));
const AlbumsPage = lazyMediaPage('AlbumsPage');
const AlbumPage = lazyMediaPage('AlbumPage');
const TagsBrowsePage = lazy(() =>
  import('@marinoscar/memoriahub-web/tagging/ui').then((m) => ({ default: m.TagsBrowsePage })),
);
const PlacesOverviewPage = lazyMediaPage('PlacesOverviewPage');
const LevelBrowsePage = lazyMediaPage('LevelBrowsePage');
const BurstsPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.BurstsPage })));
const BurstGroupPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.BurstGroupPage })));
const DuplicatesPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.DuplicatesPage })));
const DuplicateGroupPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.DuplicateGroupPage })));
const LocationSuggestionsPage = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.LocationSuggestionsPage })));
const LocationSuggestionRunRedirect = lazy(() => import('@marinoscar/memoriahub-web/review/ui').then((m) => ({ default: m.LocationSuggestionRunRedirect })));
const ReviewRunPage = lazy(() => import('@marinoscar/memoriahub-web/review-runs/ui').then((m) => ({ default: m.ReviewRunPage })));
const ReviewHubPage = lazy(() => import('./pages/Reviews/ReviewHubPage'));
const CollectionsHubPage = lazy(() => import('./pages/Collections/CollectionsHubPage'));
const ReviewQueuePage = lazy(() => import('./pages/Reviews/ReviewQueuePage'));
const ReviewInsightsPage = lazy(() => import('./pages/Insights/ReviewInsightsPage'));
const ArchivePage = lazyMediaPage('ArchivePage');
const SharedWithMePage = lazy(() => import('./pages/Shared/SharedWithMePage'));
const TrashPage = lazyMediaPage('TrashPage');
const TrashEmptyRunPage = lazy(() => import('@marinoscar/memoriahub-web/review-runs/ui').then((m) => ({ default: m.TrashEmptyRunPage })));
const LegacyShareRedirect = lazy(() => import('./pages/Public/LegacyShareRedirect'));
// RETRO-I4 (#578): public links are the sharing slice's; the page resolves `/s#lnk_...` and
// renders the `media_item` / `album` renderers registered in `platform/linkRenderers`.
const PublicLinkPage = lazy(() =>
  import('@marinoscar/platform-web/sharing/ui').then((module) => ({ default: module.PublicLinkPage })),
);
const PublicSharesPage = lazy(() => import('./pages/Admin/PublicSharesPage'));
// RETRO-J11: the workflow list and builder pages are the packaged slice's.
const WorkflowListPage = lazy(() =>
  import('@marinoscar/memoriahub-web/workflows/ui').then((m) => ({ default: m.WorkflowListPage })),
);
const WorkflowBuilderPage = lazy(() =>
  import('@marinoscar/memoriahub-web/workflows/ui').then((m) => ({ default: m.WorkflowBuilderPage })),
);
const WorkflowRunPage = lazy(() => import('@marinoscar/memoriahub-web/workflows/ui').then((m) => ({ default: m.WorkflowRunPage })));
const EnhancementsPage = lazy(() => import('@marinoscar/memoriahub-web/enhancement/ui').then((m) => ({ default: m.EnhancementsPage })));
const EnhancementBatchPage = lazy(() => import('@marinoscar/memoriahub-web/enhancement/ui').then((m) => ({ default: m.EnhancementBatchPage })));
const NotificationsPage = lazy(() => import('./pages/Notifications/NotificationsPage'));
// RETRO-J11: the memories pages are the packaged slice's.
type MemoriesUiModule = typeof import('@marinoscar/memoriahub-web/memories/ui');
const lazyMemoriesPage = <K extends keyof MemoriesUiModule>(name: K) =>
  lazy(() =>
    import('@marinoscar/memoriahub-web/memories/ui').then((m) => ({
      default: m[name] as unknown as ComponentType<any>,
    })),
  );
const MemoriesPage = lazyMemoriesPage('MemoriesPage');
const MemoryDetailPage = lazyMemoriesPage('MemoryDetailPage');
// RETRO-T2 (#625): the telemetry slice's three pages, each from its own package
// entry so a lazy route keeps its own chunk (the `telemetry/ui` barrel would put
// all three, the charts and the SQL editor in one).
const TelemetrySettingsPage = lazy(() => import('@marinoscar/platform-web/telemetry/ui/settings-page'));
const TelemetryExplorerPage = lazy(() => import('@marinoscar/platform-web/telemetry/ui/explorer-page'));
const TelemetryDashboardPage = lazy(() => import('@marinoscar/platform-web/telemetry/ui/dashboard-page'));
// RETRO-H5 (#609): the packaged alerts page, in its own chunk.
const AlertsAdminPage = lazy(() => import('./platform/alerts/AlertsAdminPage'));
// RETRO-H4 (#603): the webhooks slice's one page, routed once per scope.
const WebhooksPage = lazy(() =>
  import('@marinoscar/platform-web/webhooks/ui').then((m) => ({ default: m.WebhooksPage })),
);

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import('./pages/TestLoginPage'));

function AppRoutes() {
  return (
    <>
      {/* PWA (issue #482): outside <Routes>, <ErrorBoundary> and the
          maintenance gate, so the service worker registers — and a waiting
          update can be offered — on every route, including /login, public
          share pages and the maintenance takeover (which is exactly when a
          fixed build is about to land). Both render null by default. */}
      <UpdatePrompt useRegisterSW={useRegisterSW} />
      <InstallPrompt appName={APP_NAME} />
      <ErrorBoundary>
        {/* Maintenance mode (issue #348): sits outside <Routes> so the takeover
            is global — every route, authenticated or not — instead of each
            page having to handle a maintenance 503 itself. */}
        <MaintenanceGate appName={APP_NAME}>
        <Suspense fallback={<LoadingSpinner fullScreen />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="/s" element={<PublicLinkPage apiClient={appPlatformApi} />} />
            {/* Links made before RETRO-I4 carried the token in the path: move it to the fragment. */}
            <Route path="/s/:token" element={<LegacyShareRedirect />} />

            {/* Test login (development only) */}
            {!import.meta.env.PROD && TestLoginPage && (
              <Route path="/testing/login" element={<TestLoginPage />} />
            )}

            {/* Protected routes */}
            <Route element={<RequireAuth loading={<LoadingSpinner fullScreen />} />}>
              {/* Device activation page - without layout for full-screen experience */}
              {/* The Android pairing returns to the app with `clientInfo.returnUri`
                  (`memoriahub:` deep links; `https:` is always accepted). */}
              <Route path="/activate" element={<ActivateDevicePage returnUriSchemes={['memoriahub']} />} />

              <Route element={<Layout />}>
                <Route path="/" element={<HomePage />} />
                {/* The per-user hub (RETRO-B5, #621): a binding over the packaged
                    SettingsHub. Every card of USER_SETTINGS_SECTIONS routes
                    to a page under /settings/<card>. */}
                <Route path="/settings" element={<UserSettingsHubPage />} />
                <Route path="/settings/profile" element={<ProfilePage />} />
                <Route path="/settings/appearance" element={<AppearanceSettingsPage />} />
                <Route path="/settings/time-zone" element={<TimeZoneSettingsPage />} />
                <Route path="/settings/notifications" element={<NotificationPreferencesPage />} />
                <Route path="/settings/memories" element={<MemoriesPreferencesPage />} />
                <Route path="/settings/search" element={<SearchPreferencesPage />} />
                {/* RETRO-H1 (#591). Ungated like every `/settings/*` sibling: the API gates
                    `/api/user-data/*` on `user_settings:write`, which every role holds, and
                    scopes each request to the caller's own data. The typed confirmation in
                    the page's dialog is the deliberate act, not an authorization. */}
                <Route path="/settings/danger-zone" element={<UserDangerZonePage />} />
                {/* RETRO-H3 (#599): the user steps of `GET /api/onboarding`, which needs
                    only `user_settings:read` (every role). */}
                <Route path="/settings/getting-started" element={<GettingStartedPage />} />
                {/* RETRO-H2 (#596): "Download your data". Ungated like its siblings: every source
                    is checked by the API (`user-data` on `user_settings:read`, MemoriaHub's on
                    `media:read`, both held by every role); the `export.ready` notification links here. */}
                <Route path="/settings/data-export" element={<DataExportPage />} />
                {/* Android app + Media Sync (issue #515). */}
                <Route path="/settings/android-app" element={<AndroidAppDownloadPage />} />
                <Route
                  path="/settings/media-sync"
                  element={
                    <RequirePermission permission="media:read" fallback={<Navigate to="/settings" replace />}>
                      <MediaSyncPage />
                    </RequirePermission>
                  }
                />
                {/* The Profile page moved under the user hub (RETRO-B5); the old URL
                    still resolves. */}
                <Route path="/profile" element={<Navigate to="/settings/profile" replace />} />
                <Route path="/media" element={<MediaLibraryPage />} />
                {/* RETRO-I6 (#588): shared libraries are platform groups, managed on the
                    packaged pages behind `groups:read` (the string `/api/groups` enforces;
                    writes are gated inside the pages). The former circle URLs redirect. */}
                <Route
                  path="/settings/groups"
                  element={
                    <RequirePermission permission="groups:read" fallback={<Navigate to="/settings" replace />}>
                      <GroupsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/settings/groups/:id"
                  element={
                    <RequirePermission permission="groups:read" fallback={<Navigate to="/settings" replace />}>
                      <GroupDetailPage />
                    </RequirePermission>
                  }
                />
                <Route path="/circles" element={<Navigate to="/settings/groups" replace />} />
                <Route path="/circles/:id" element={<LegacyCircleRedirect />} />
                {/* Settings Hub */}
                <Route path="/admin/settings" element={<SettingsHubPage />} />
                <Route
                  path="/admin/settings/general"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <SystemSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/users"
                  element={
                    <RequirePermission permission="users:read" fallback={<Navigate to="/" replace />}>
                      <UsersPage />
                    </RequirePermission>
                  }
                />
                <Route path="/settings/tokens" element={<UserTokensPage />} />
                <Route
                  path="/admin/settings/ai"
                  element={
                    <RequirePermission permission="ai_config:read" fallback={<Navigate to="/" replace />}>
                      <AiConfigRoute />
                    </RequirePermission>
                  }
                />
                {/* Not the switch: hidden while AI is off (RequireAiEnabled), like their cards. */}
                <Route
                  path="/admin/settings/ai/models"
                  element={
                    <RequirePermission permission="ai_config:read" fallback={<Navigate to="/" replace />}>
                      <RequireAiEnabled fallback={<Navigate to="/admin/settings/ai" replace />}>
                        <AiModelsRoute />
                      </RequireAiEnabled>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/ai/usage"
                  element={
                    <RequirePermission permission="ai_config:read" fallback={<Navigate to="/" replace />}>
                      <RequireAiEnabled fallback={<Navigate to="/admin/settings/ai" replace />}>
                        <AiUsageRoute />
                      </RequireAiEnabled>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/tagging"
                  element={
                    <RequirePermission permission="ai_config:read" fallback={<Navigate to="/" replace />}>
                      <TaggingSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/face"
                  element={
                    <RequirePermission permission="face_settings:read" fallback={<Navigate to="/" replace />}>
                      <FaceSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/bursts"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <BurstsSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/duplicates"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <DuplicatesSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/social-media"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <SocialMediaSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/enhancer"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <EnhancerSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/memories"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <MemoriesSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/location-inference"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <LocationInferenceSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/location-groups"
                  element={
                    <RequirePermission permission="geo_settings:read" fallback={<Navigate to="/" replace />}>
                      <LocationGroupsSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/archiving"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <ArchivingSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/geo"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <GeoSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/email"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <EmailSettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/push"
                  element={
                    <RequirePermission permission="push:read" fallback={<Navigate to="/" replace />}>
                      <PushConfigPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/notifications"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <NotificationPolicyPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/android"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <AndroidAppPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/storage"
                  element={
                    <RequirePermission permission="storage_config:read" fallback={<Navigate to="/" replace />}>
                      <StorageConfigPage />
                    </RequirePermission>
                  }
                />
                {/* MemoriaHub's former Storage Providers page (RETRO-D1): the platform page replaces it. */}
                <Route path="/admin/settings/storage/providers" element={<Navigate to="/admin/settings/storage" replace />} />
                <Route
                  path="/admin/settings/storage/insights"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <StorageInsightsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/jobs"
                  element={
                    <RequirePermission permission="jobs:read" fallback={<Navigate to="/" replace />}>
                      <JobsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/jobs/insights"
                  element={
                    <RequirePermission permission="jobs:read" fallback={<Navigate to="/" replace />}>
                      <JobInsightsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/workers"
                  element={
                    <RequirePermission permission="nodes:read" fallback={<Navigate to="/" replace />}>
                      <WorkersPage slots={appWorkersPageSlots} />
                    </RequirePermission>
                  }
                />
                {/* Local Media Backup (epic #308) stays an app page: reached from the Worker Nodes
                    page's "Local backup" row action. `/admin/settings/nodes*` is the old address. */}
                <Route path="/admin/settings/workers/:id/backup" element={<NodeBackupPage />} />
                <Route path="/admin/settings/nodes" element={<Navigate to="/admin/settings/workers" replace />} />
                <Route path="/admin/settings/nodes/:id/backup" element={<NodeBackupPage />} />
                {/* RETRO-B1b (#602): the packaged Doctor, behind the permission
                    `GET /api/admin/doctor` enforces. */}
                <Route
                  path="/admin/settings/doctor"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <DoctorPage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-B1 (#597). Same permission string the `Maintenance` and
                    `About` cards declare and the platform host's controllers
                    enforce on their GETs. Opening and closing a window needs
                    `system_settings:write`, which the page gates by disabling its
                    controls. The maintenance route is the one the packaged
                    `MaintenanceGate` never covers (`MAINTENANCE_ADMIN_PATH`),
                    mirroring `@AllowDuringMaintenance()` on the controller behind
                    it: the switch that ends a window has to be reachable while the
                    window is open. */}
                <Route
                  path="/admin/settings/maintenance"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <AdminMaintenancePage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/about"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <AboutPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/broadcasts"
                  element={
                    <RequirePermission permission="broadcasts:read" fallback={<Navigate to="/" replace />}>
                      <BroadcastsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/workflows"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <WorkflowsSettingsPage />
                    </RequirePermission>
                  }
                />
                {/* v0 server-side backup retired (#367) — superseded by the node-based
                    Local Media Backup reachable from the Worker Nodes page. */}
                <Route
                  path="/admin/settings/backup"
                  element={<Navigate to="/admin/settings/workers" replace />}
                />
                <Route
                  path="/admin/settings/db-backup"
                  element={
                    <RequirePermission permission="db_backup:read" fallback={<Navigate to="/" replace />}>
                      <DbBackupPage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-H1 (#591). `system:factory_reset`, the exact SYSTEM permission the
                    platform factory reset controller enforces (Admin only; never implied by
                    `system_settings:write`). Declared by the pinned-last Danger Zone card. */}
                <Route
                  path="/admin/settings/factory-reset"
                  element={
                    <RequirePermission permission="system:factory_reset" fallback={<Navigate to="/" replace />}>
                      <FactoryResetPage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-H2 (#596). `org_members:read`, the exact string the exports service checks
                    for the platform `org-data` source (an organization's rows). Same packaged page
                    as `/settings/data-export`: its dialog lists `org-data` for this holder. */}
                <Route
                  path="/admin/settings/data-export"
                  element={
                    <RequirePermission permission="org_members:read" fallback={<Navigate to="/" replace />}>
                      <DataExportPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/sharing"
                  element={
                    <RequirePermission permission="sharing:admin" fallback={<Navigate to="/" replace />}>
                      <PublicSharesPage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-T2 (#625): the telemetry slice's three pages, each guarded
                    on the exact string its card declares and the telemetry
                    controllers enforce: `telemetry:read` for the settings page
                    (saving needs `telemetry:write`, which the PAGE gates),
                    `telemetry:query` for the Explorer and the Dashboard. The
                    settings page is NOT behind `RequireTelemetryEnabled` (it is
                    where telemetry is switched on); the two query pages are, as
                    their cards carry `feature: 'telemetry'`. Nested paths, not
                    tabs: the longest-prefix title resolver names them. */}
                <Route
                  path="/admin/settings/telemetry"
                  element={
                    <RequirePermission permission="telemetry:read" fallback={<Navigate to="/" replace />}>
                      <TelemetrySettingsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/telemetry/explorer"
                  element={
                    <RequirePermission permission="telemetry:query" fallback={<Navigate to="/" replace />}>
                      <RequireTelemetryEnabled loading={<LoadingSpinner />}>
                        <TelemetryExplorerPage />
                      </RequireTelemetryEnabled>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/telemetry/dashboard"
                  element={
                    <RequirePermission permission="telemetry:query" fallback={<Navigate to="/" replace />}>
                      <RequireTelemetryEnabled loading={<LoadingSpinner />}>
                        <TelemetryDashboardPage />
                      </RequireTelemetryEnabled>
                    </RequirePermission>
                  }
                />
                {/* RETRO-H5 (#609): the alerts page, guarded on the exact string its card
                    declares and every read route of /api/admin/alerts enforces. Writes
                    (`alerts:write`) are gated by the PAGE. */}
                <Route
                  path="/admin/settings/alerts"
                  element={
                    <RequirePermission permission="alerts:read" fallback={<Navigate to="/" replace />}>
                      <AlertsAdminPage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-H3 (#599): the Setup guide, behind `system_settings:read`, the
                    onboarding slice's `adminPermission` (the admin block and the metrics). */}
                <Route
                  path="/admin/settings/setup"
                  element={
                    <RequirePermission permission="system_settings:read" fallback={<Navigate to="/" replace />}>
                      <SetupGuidePage />
                    </RequirePermission>
                  }
                />
                {/* RETRO-H4 (#603): the two Webhooks cards' routes, each gated on the exact
                    string its controller enforces: `webhooks:read` (`/api/webhooks`, the
                    caller's own endpoints) and `system_webhooks:read` (`/api/admin/webhooks`).
                    The `org` scope (`/api/org/webhooks`) is not routed in single-organization mode. */}
                <Route
                  path="/settings/webhooks"
                  element={
                    <RequirePermission permission="webhooks:read" fallback={<Navigate to="/settings" replace />}>
                      <WebhooksPage scope="user" />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings/webhooks"
                  element={
                    <RequirePermission permission="system_webhooks:read" fallback={<Navigate to="/" replace />}>
                      <WebhooksPage scope="system" />
                    </RequirePermission>
                  }
                />
                {/* Legacy admin route redirects */}
                <Route path="/admin/users" element={<Navigate to="/admin/settings/users" replace />} />
                <Route path="/admin/ai-settings" element={<Navigate to="/admin/settings/ai" replace />} />
                <Route path="/admin/face-settings" element={<Navigate to="/admin/settings/face" replace />} />
                <Route path="/admin/jobs" element={<Navigate to="/admin/settings/jobs" replace />} />
                <Route path="/admin/tags" element={<Navigate to="/admin/settings/tagging" replace />} />
                <Route path="/admin/insights" element={<Navigate to="/admin/settings/storage/insights" replace />} />
                <Route path="/admin/storage-providers" element={<Navigate to="/admin/settings/storage" replace />} />
                <Route path="/admin/backup" element={<Navigate to="/admin/settings/workers" replace />} />
                {/* Agentic/semantic search and the enhancer are AI surfaces: hidden while AI is off (RETRO-E2, #601). */}
                <Route
                  path="/search"
                  element={
                    <RequireAiEnabled>
                      <SearchPage />
                    </RequireAiEnabled>
                  }
                />
                {/* The Collections hub (issue #391, spec §4.6) ADDS a route; it
                    replaces none. Every browse destination below keeps its own
                    URL, because bookmarks, deep links, the Android app and the
                    notification links all point at them. On desktop this page
                    redirects to `/albums` rather than rendering the card grid —
                    the #392 context pane already carries the overview. */}
                <Route path="/collections" element={<CollectionsHubPage />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/people/archived" element={<ArchivedFacesPage />} />
                <Route path="/tags" element={<TagsBrowsePage />} />
                <Route path="/places" element={<PlacesOverviewPage />} />
                <Route path="/places/countries" element={<LevelBrowsePage level="countries" />} />
                <Route path="/places/regions" element={<LevelBrowsePage level="regions" />} />
                <Route path="/places/cities" element={<LevelBrowsePage level="cities" />} />
                <Route path="/albums" element={<AlbumsPage />} />
                <Route path="/albums/:albumId" element={<AlbumPage />} />
                <Route path="/workflows" element={<WorkflowListPage />} />
                <Route path="/workflows/new" element={<WorkflowBuilderPage />} />
                <Route path="/workflows/:id" element={<WorkflowBuilderPage />} />
                <Route path="/workflows/:id/runs/:runId" element={<WorkflowRunPage />} />
                <Route
                  path="/enhancements"
                  element={
                    <RequireAiEnabled>
                      <EnhancementsPage />
                    </RequireAiEnabled>
                  }
                />
                {/* Bulk AI enhance progress — a run page like the others (#423). */}
                <Route path="/enhancement-batches/:id" element={<EnhancementBatchPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                {/* Memories (epic #300). The routes always resolve — a bookmark
                    must not 404 — and each page renders its own disabled state
                    when `features.memories` is off. */}
                <Route path="/memories" element={<MemoriesPage />} />
                <Route path="/memories/:id" element={<MemoryDetailPage />} />
                {/* The Review hub (issue #390). It ADDS a namespace; it does not
                    replace one — every queue's standalone route below still
                    resolves, because bookmarks, the Home review banners and the
                    `review_queue_*` notification links all point at them. */}
                <Route path="/review" element={<ReviewHubPage />} />
                <Route path="/review/:queue" element={<ReviewQueuePage />} />
                <Route path="/bursts" element={<BurstsPage />} />
                <Route path="/bursts/:id" element={<BurstGroupPage />} />
                <Route path="/duplicates" element={<DuplicatesPage />} />
                <Route path="/duplicates/:id" element={<DuplicateGroupPage />} />
                <Route path="/review-insights" element={<ReviewInsightsPage />} />
                <Route path="/location-suggestions" element={<LocationSuggestionsPage />} />
                {/* Deprecated alias — location-suggestion runs are review runs now. */}
                <Route path="/location-suggestion-runs/:runId" element={<LocationSuggestionRunRedirect />} />
                <Route path="/review-runs/:runId" element={<ReviewRunPage />} />
                <Route path="/archive" element={<ArchivePage />} />
                {/* Shared with me (RETRO-I6, #588): records granted to the caller. */}
                <Route path="/shared" element={<SharedWithMePage />} />
                <Route path="/trash" element={<TrashPage />} />
                <Route path="/trash/runs/:runId" element={<TrashEmptyRunPage />} />
                {/* The map owns the whole content area: it asks the shell for the
                    full-bleed <main> itself (useShellMainVariant), so the shell is
                    not remounted on the way in or out. */}
                <Route path="/map" element={<MediaMapPage />} />
              </Route>
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </MaintenanceGate>
      </ErrorBoundary>
    </>
  );
}

export default function App() {
  return (
    <ShellRoot themes={APP_THEMES} storageKey={THEME_STORAGE_KEY}>
      <AuthProvider>
        {/* The platform host (RETRO-B1, #597): the transport and viewer every
            packaged page and hook reads. Inside the auth provider (it reads the
            signed-in user's permissions), above the router outlet. */}
        {/* RETRO-T2 (#625): the one `GET /api/telemetry/config` answer the
            `telemetry` settings feature, the route guard and the settings page
            read; fetched only once signed in. */}
        <AppTelemetryConfigProvider>
        <AppPlatformHostProvider>
          <IdentityWebAdaptersProvider adapters={appIdentityAdapters}>
            <JobsWebAdaptersProvider adapters={appJobsAdapters}>
              <TelemetryWebAdaptersProvider adapters={appTelemetryAdapters}>
                <OwnerScopeProvider>
                  {/* RETRO-J11 (#626): the host the packaged `@marinoscar/memoriahub-web`
                      slices read (API client, principal, features, owner scope, slots). */}
                  <MemoriahubHostBinding>
                    <AppRoutes />
                  </MemoriahubHostBinding>
                </OwnerScopeProvider>
              </TelemetryWebAdaptersProvider>
            </JobsWebAdaptersProvider>
          </IdentityWebAdaptersProvider>
        </AppPlatformHostProvider>
        </AppTelemetryConfigProvider>
      </AuthProvider>
    </ShellRoot>
  );
}
