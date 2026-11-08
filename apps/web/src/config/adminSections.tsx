/**
 * The admin (Console) information architecture — ONE declaration, three consumers.
 *
 * `SettingsHubPage` already grouped all admin pages into five permission-gated
 * sections. That structure was good; it was just trapped inside a *page*, which
 * is why every admin-to-admin move used to route back through a landing screen.
 * Epic #388 / issue #389 promotes it from a destination into navigation, so the
 * array now lives here and is consumed by:
 *
 *   1. `SettingsHubPage`      — a binding over the packaged `SettingsHub`
 *                               (card grid; phone drill-down list)
 *   2. `Sidebar` Console mode — the rail's contents at any `/admin/*` route
 *   3. `AppBar`               — resolving an admin route to its page title
 *
 * Console mode "invents no new admin IA" (spec §3.2) is enforced structurally by
 * there being exactly one array: a card added here appears in all three surfaces,
 * and none of them can drift from the others.
 *
 * `Icon` is a COMPONENT, not an element, deliberately — the hub renders it at
 * 40px and the rail at ~20px, so the size cannot be baked into the declaration.
 */

import './settingsFeatures';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';
import AiIcon from '@mui/icons-material/SmartToy';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import FaceIcon from '@mui/icons-material/Face';
import BurstModeIcon from '@mui/icons-material/BurstMode';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import MapIcon from '@mui/icons-material/Map';
import StorageIcon from '@mui/icons-material/Storage';
import InsightsIcon from '@mui/icons-material/Insights';
import ArchiveIcon from '@mui/icons-material/Archive';
import PublicIcon from '@mui/icons-material/Public';
import MovieIcon from '@mui/icons-material/Movie';
import HubIcon from '@mui/icons-material/Hub';
import EmailIcon from '@mui/icons-material/Email';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import AndroidIcon from '@mui/icons-material/Android';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import { doctorSettingsPage } from '@marinoscar/platform-web/doctor/ui';
import { setupGuideSettingsPage } from '@marinoscar/platform-web/onboarding/ui';
import { identityAdminSections } from '@marinoscar/platform-web/identity/ui';
import { jobsAdminSections } from '@marinoscar/platform-web/jobs/ui';
import { dbBackupAdminSections } from '@marinoscar/platform-web/db-backup/ui';
// RETRO-T2 (#625): the telemetry slice's three cards (data only; no page reaches the main chunk).
import { telemetryAdminCards } from '@marinoscar/platform-web/telemetry/ui';
import { webhooksAdminSections } from '@marinoscar/platform-web/webhooks/ui';
// RETRO-H5 (#609): the alerts slice's card (data only; the page is lazy in App.tsx).
import { alertsAdminCards } from '@marinoscar/platform-web/alerts/ui';
// RETRO-H1 (#591): the user-data slice's factory reset card, in the pinned-last Danger Zone group.
import { DANGER_ZONE_GROUP_LABEL } from '@marinoscar/platform-web/user-data/headless';
import { factoryResetSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import {
  settingsPageTitle,
  visibleSettingsSections,
  type SettingsCardDef,
  type SettingsSectionDef,
} from '@marinoscar/platform-web/settings/ui';
import type { SettingsFeatures } from '@marinoscar/platform-web/settings/headless';

/**
 * The card and section shapes are the platform's (`SettingsCardDef`,
 * `SettingsSectionDef` of `@marinoscar/platform-web/settings/ui`, RETRO-B5
 * #621): the packaged `SettingsHub` draws this registry, so it cannot keep a
 * type of its own. The old names stay as aliases for the consumers that still
 * import them.
 */
export type AdminCardDef = SettingsCardDef;
export type AdminSectionDef = SettingsSectionDef;

export const ADMIN_SECTIONS: AdminSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        title: 'System',
        description: 'Configure core system settings, application behavior, and global defaults.',
        Icon: AdminIcon,
        path: '/admin/settings/general',
        permission: 'system_settings:read',
      },
      // Users & Allowlist: the identity slice's card, as data (RETRO-B2). The
      // Organization cards are not spread: single-organization mode hides them.
      ...identityAdminSections.access,
      {
        title: 'Archiving & Deletion',
        description: 'Manage the Trash retention period and review how archiving and deletion work.',
        Icon: ArchiveIcon,
        path: '/admin/settings/archiving',
        permission: 'system_settings:read',
      },
      {
        title: 'Email',
        description: 'Configure the outbound email provider (AWS SES or SMTP) and test delivery.',
        Icon: EmailIcon,
        path: '/admin/settings/email',
        // RETRO-D2 (#570): the page is the platform's, and the platform
        // `email-settings.controller` gates `GET /api/email-settings` on
        // `system_settings:read` (saving and the test send need
        // `system_settings:write`, which the page gates internally).
        permission: 'system_settings:read',
      },
      {
        title: 'Web Push',
        description:
          'Generate the VAPID key pair, switch web push on or off, and test delivery to your devices.',
        Icon: VpnKeyOutlinedIcon,
        path: '/admin/settings/push',
        permission: 'push:read',
      },
      {
        title: 'Notifications',
        description:
          'Turn browser notifications and web push on or off for everyone, and silence individual notification types.',
        Icon: NotificationsOutlinedIcon,
        path: '/admin/settings/notifications',
        permission: 'system_settings:read',
      },
      {
        // Issue #516 (epic #498): `GET /api/admin/android-app` and the release
        // list both enforce `system_settings:read`; writes are gated inside
        // the page on `system_settings:write`.
        title: 'Android app',
        description: 'Releases and trusted signing keys for the MemoriaHub Android app.',
        Icon: AndroidIcon,
        path: '/admin/settings/android',
        permission: 'system_settings:read',
      },
      // RETRO-H3 (#599): the onboarding slice's Setup guide card, appended, as data.
      // `system_settings:read` is the permission the platform onboarding slice adds the
      // `admin` block of `GET /api/onboarding` for, and gates `GET /api/admin/onboarding/metrics`
      // on (its default `adminPermission`; no `onboarding:read` exists).
      { ...setupGuideSettingsPage.card, Icon: setupGuideSettingsPage.Icon },
    ],
  },
  {
    label: 'AI & Enrichment',
    cards: [
      {
        title: 'AI Providers',
        description: 'Configure AI provider credentials and set the active model for search and tagging.',
        Icon: AiIcon,
        path: '/admin/settings/ai',
        permission: 'ai_settings:read',
      },
      {
        title: 'Tagging & Descriptions',
        description: 'Manage the tag vocabulary and configure automatic photo tagging behavior.',
        Icon: LocalOfferIcon,
        path: '/admin/settings/tagging',
        permission: 'ai_settings:read',
      },
      {
        title: 'Face Recognition',
        description: 'Set up face detection providers and configure recognition thresholds.',
        Icon: FaceIcon,
        path: '/admin/settings/face',
        permission: 'face_settings:read',
      },
      {
        title: 'Bursts & Similar Pictures',
        description: 'Tune burst detection sensitivity, time windows, and review queue settings.',
        Icon: BurstModeIcon,
        path: '/admin/settings/bursts',
        permission: 'system_settings:read',
      },
      {
        title: 'Near-Duplicate Detection',
        description: 'Tune visual-duplicate matching sensitivity and run global backfills.',
        Icon: ContentCopyIcon,
        path: '/admin/settings/duplicates',
        permission: 'system_settings:read',
      },
      {
        title: 'AI Picture Enhancer',
        description:
          'Enable AI photo enhancement and set the quality, strength, and review presets.',
        Icon: AutoFixHighIcon,
        path: '/admin/settings/enhancer',
        permission: 'system_settings:read',
      },
      {
        title: 'Memories',
        description: 'Automatic memory curation, story feed, and email digests.',
        Icon: AutoAwesomeMotionIcon,
        path: '/admin/settings/memories',
        permission: 'system_settings:read',
      },
      {
        title: 'Social Media Detection',
        description: 'Detect TikTok/Instagram/Facebook videos and skip enrichment',
        Icon: MovieIcon,
        path: '/admin/settings/social-media',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'Media',
    cards: [
      {
        title: 'Geo Location',
        description: 'Configure reverse geocoding providers and forward search settings.',
        Icon: MapIcon,
        path: '/admin/settings/geo',
        permission: 'system_settings:read',
      },
      {
        title: 'Location Inference',
        description: 'Tune GPS interpolation from nearby photos, auto-apply thresholds, and run global backfills.',
        Icon: MyLocationIcon,
        path: '/admin/settings/location-inference',
        permission: 'system_settings:read',
      },
      {
        title: 'Location Groups',
        description:
          'Collapse duplicate geocoder spellings of a place into one canonical name; merge suggestions and define capture areas.',
        Icon: PublicIcon,
        path: '/admin/settings/location-groups',
        permission: 'geo_settings:read',
      },
    ],
  },
  {
    label: 'Storage',
    cards: [
      {
        title: 'Storage Providers',
        description:
          'Manage S3, R2, and local storage credentials, set the active provider, and run migrations.',
        Icon: StorageIcon,
        path: '/admin/settings/storage/providers',
        permission: 'storage_settings:read',
      },
      {
        title: 'Storage Insights',
        description: 'View precomputed storage usage metrics and trigger manual snapshot refreshes.',
        Icon: InsightsIcon,
        path: '/admin/settings/storage/insights',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'Operations',
    cards: [
      // RETRO-C1 (#575): the packaged Jobs and Job Insights cards (`jobs:read`, the string
      // `GET /api/admin/jobs*` enforces). The nodes slice's own Worker Nodes card in the same
      // array is NOT spread: the app keeps its `WorkersPage` until RETRO-C2.
      ...jobsAdminSections.operations.filter((card) => card.path.startsWith('/admin/settings/jobs')),
      {
        title: 'Worker Nodes',
        description: 'Distributed CLI worker nodes: fleet health, heartbeats, and per-node job stats.',
        Icon: HubIcon,
        path: '/admin/settings/nodes',
        permission: 'jobs:read',
      },
      // RETRO-D4 (#580): the packaged Database Backup card, at the position the app's own card had.
      // `db_backup:read` is the string `GET /api/admin/db-backup/*` enforces.
      ...dbBackupAdminSections.operations,
      {
        title: 'Public Sharing',
        description: 'View and manage all public share links; revoke or set expirations in bulk.',
        Icon: PublicIcon,
        path: '/admin/settings/sharing',
        permission: 'shares:manage_any',
      },
      {
        title: 'Workflow Automation',
        description: 'Control workflow blast radius, throughput, and safety; oversee runs across all circles.',
        Icon: AccountTreeIcon,
        path: '/admin/settings/workflows',
        permission: 'system_settings:read',
      },
      // RETRO-B1b (#602): the packaged Doctor card. `system_settings:read` is the
      // string `GET /api/admin/doctor` enforces (`DEFAULT_DOCTOR_PERMISSION`).
      { ...doctorSettingsPage.card, Icon: doctorSettingsPage.Icon },
      {
        title: 'Broadcasts',
        description:
          'Send an announcement to every active user now or on a schedule, and watch it go out.',
        Icon: CampaignOutlinedIcon,
        path: '/admin/settings/broadcasts',
        permission: 'broadcasts:read',
      },
      {
        // RETRO-B1 (#597). `system_settings:read` is the string the platform
        // host's maintenance controller enforces on `GET /api/admin/maintenance`
        // (`PlatformHostCoreModule.forRoot`'s `permissions.maintenanceRead`
        // default). Opening and closing a window needs `system_settings:write`,
        // which the PAGE gates by disabling its controls. This used to be a tab
        // of the System page; a settings page is never a tab (Settings UI
        // Pattern), so it is a card, and the route keeps the packaged
        // `MAINTENANCE_ADMIN_PATH`.
        title: 'Maintenance',
        description:
          'Take the application out of service for planned work, with a message for anyone who tries to use it.',
        Icon: BuildCircleOutlinedIcon,
        path: '/admin/settings/maintenance',
        permission: 'system_settings:read',
      },
      {
        // RETRO-B1 (#597). `system_settings:read` is the string the platform
        // host's About controller enforces on `GET /api/admin/about`. Read-only
        // by nature: there is no `:write` gate to mention.
        title: 'About',
        description:
          'What is running here: version, revision, when it was installed and last updated, and the server it runs on.',
        Icon: InfoOutlinedIcon,
        path: '/admin/settings/about',
        permission: 'system_settings:read',
      },
      // RETRO-T2 (#625): the packaged Telemetry, Telemetry Explorer and Telemetry Dashboard cards,
      // appended. Each carries the exact string the telemetry controllers enforce: `telemetry:read`
      // for the settings page (saving needs `telemetry:write`, gated inside the page; no `feature`,
      // it is where telemetry is switched on), `telemetry:query` plus `feature: 'telemetry'` for the
      // Explorer and the Dashboard (`config/settingsFeatures.ts` resolves the feature).
      ...telemetryAdminCards,
      // RETRO-H5 (#609): the packaged Alerts card, appended. `alerts:read` is the exact string every
      // read route of `/api/admin/alerts` enforces; writes (`alerts:write`) are gated inside the page.
      // No `feature`: node and queue rules work with telemetry switched off.
      ...alertsAdminCards,
      // RETRO-H4 (#603): the packaged Webhooks card (the deployment's endpoints), appended.
      // `system_webhooks:read` is the string `GET /api/admin/webhooks` enforces; writes need
      // `system_webhooks:write`, gated inside the page. The organization card
      // (`webhooksAdminSections.organizations`, `feature: 'orgs'`) is not spread, like the other
      // organization cards: no organization page is routed in single-organization mode.
      ...webhooksAdminSections.operations,
      {
        // RETRO-H2 (#596), appended. `org_members:read` is the exact string the exports service
        // checks for the platform `org-data` source; the page is the packaged `DataExportPage`.
        title: 'Organization data export',
        description:
          'Export what this deployment stores for the organization (members, files list, settings) as JSON, CSV or Excel.',
        Icon: CloudDownloadOutlinedIcon,
        path: '/admin/settings/data-export',
        permission: 'org_members:read',
      },
    ],
  },
  // RETRO-H1 (#591). `Danger Zone`, PINNED LAST: the one documented exception to
  // append-only (a group added later goes BEFORE this one; the registry test asserts
  // it with `dangerZoneLastViolations`). The packaged factory reset page:
  // `system:factory_reset`, the exact SYSTEM permission the platform controller
  // enforces (Admin only; never implied by `system_settings:write`). No `feature`.
  {
    label: DANGER_ZONE_GROUP_LABEL,
    cards: [{ ...factoryResetSettingsPage.card, Icon: factoryResetSettingsPage.Icon }],
  },
];

/** The Console hub itself — the one admin route that owns no card. */
export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';

/**
 * Filter the sections to what `hasPermission` (and `features`) allow, dropping
 * sections that end up empty, optionally applying the hub's title search.
 *
 * Since RETRO-B5 (#621) this is the packaged gate (`visibleSettingsSections`),
 * the same function the packaged `SettingsHub` runs over `ADMIN_SECTIONS`, so
 * the hub and the Console rail cannot disagree about what an admin may see.
 */
export function visibleAdminSections(
  hasPermission: (permission: string) => boolean,
  query = '',
  features: SettingsFeatures = {},
): AdminSectionDef[] {
  return visibleSettingsSections(ADMIN_SECTIONS, hasPermission, query, features);
}

/**
 * Resolve an `/admin/*` pathname to the human title of the page it renders.
 *
 * Longest-match wins (on segment boundaries) so `/admin/settings/jobs/insights`
 * resolves to "Job Queue Insights" rather than "Job Queue", and
 * `/admin/settings/nodes/:id/backup` still resolves to its parent's "Worker
 * Nodes". Returns `null` for a path that is not under `/admin`; any other
 * `/admin` path falls back to the hub title.
 */
export function adminPageTitle(pathname: string, features: SettingsFeatures = {}): string | null {
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return null;
  return (
    settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, pathname, features) ??
    ADMIN_HUB_TITLE
  );
}
