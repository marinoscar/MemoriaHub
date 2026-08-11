/**
 * The admin (Console) information architecture — ONE declaration, three consumers.
 *
 * `SettingsHubPage` already grouped all admin pages into five permission-gated
 * sections. That structure was good; it was just trapped inside a *page*, which
 * is why every admin-to-admin move used to route back through a landing screen.
 * Epic #388 / issue #389 promotes it from a destination into navigation, so the
 * array now lives here and is consumed by:
 *
 *   1. `SettingsHubPage`      — the card grid (and the phone drill-down hub)
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

import type { SvgIconComponent } from '@mui/icons-material';
import {
  AdminPanelSettings as AdminIcon,
  People as PeopleIcon,
  SmartToy as AiIcon,
  LocalOffer as LocalOfferIcon,
  Face as FaceIcon,
  BurstMode as BurstModeIcon,
  ContentCopy as ContentCopyIcon,
  MyLocation as MyLocationIcon,
  Map as MapIcon,
  Storage as StorageIcon,
  Insights as InsightsIcon,
  WorkHistory as WorkHistoryIcon,
  Archive as ArchiveIcon,
  QueryStats as QueryStatsIcon,
  Public as PublicIcon,
  MonitorHeart as MonitorHeartIcon,
  Movie as MovieIcon,
  Hub as HubIcon,
  Email as EmailIcon,
  AccountTree as AccountTreeIcon,
  AutoFixHigh as AutoFixHighIcon,
  AutoAwesomeMotion as AutoAwesomeMotionIcon,
} from '@mui/icons-material';

export interface AdminCardDef {
  title: string;
  description: string;
  Icon: SvgIconComponent;
  path?: string;
  disabled?: boolean;
  permission?: string;
  alwaysShow?: boolean;
}

export interface AdminSectionDef {
  label: string;
  cards: AdminCardDef[];
}

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
      {
        title: 'Users & Allowlist',
        description: 'Manage user accounts, roles, and control who can access the application.',
        Icon: PeopleIcon,
        path: '/admin/settings/users',
        permission: 'users:read',
      },
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
        permission: 'system_settings:read',
      },
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
      {
        title: 'Job Queue',
        description: 'Monitor enrichment jobs, retry failed items, and reset stuck workers.',
        Icon: WorkHistoryIcon,
        path: '/admin/settings/jobs',
        permission: 'jobs:read',
      },
      {
        title: 'Job Queue Insights',
        description: 'Live queue stats, per-type durations, and an ETA for the backlog.',
        Icon: QueryStatsIcon,
        path: '/admin/settings/jobs/insights',
        permission: 'jobs:read',
      },
      {
        title: 'Worker Nodes',
        description: 'Distributed CLI worker nodes: fleet health, heartbeats, and per-node job stats.',
        Icon: HubIcon,
        path: '/admin/settings/nodes',
        permission: 'jobs:read',
      },
      {
        title: 'Database Backup',
        description:
          'Schedule and run PostgreSQL dumps to object storage; browse, download, and delete backups.',
        Icon: StorageIcon,
        path: '/admin/settings/db-backup',
        permission: 'db_backup:read',
      },
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
      {
        title: 'Doctor',
        description: 'Run configuration health diagnostics and see required action items',
        Icon: MonitorHeartIcon,
        path: '/admin/settings/doctor',
        permission: 'system_settings:read',
      },
    ],
  },
];

/** The Console hub itself — the one admin route that owns no card. */
export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';

/**
 * Filter the sections to what `hasPermission` allows, dropping sections that end
 * up empty. Every consumer runs the SAME gate, so a card an admin cannot open
 * can never appear in one surface and not another.
 *
 * `query` (optional) additionally applies the client-side "Search settings"
 * filter — a case-insensitive substring match on the card title (spec §4.4
 * requirement 4). Matching on title only, not description, keeps the result set
 * predictable: a two-letter query should not surface eight cards because their
 * prose happens to share a word.
 */
export function visibleAdminSections(
  hasPermission: (permission: string) => boolean,
  query = '',
): AdminSectionDef[] {
  const needle = query.trim().toLowerCase();
  return ADMIN_SECTIONS.map((section) => ({
    label: section.label,
    cards: section.cards.filter((card) => {
      if (needle && !card.title.toLowerCase().includes(needle)) return false;
      if (card.alwaysShow) return true;
      if (!card.permission) return true;
      return hasPermission(card.permission);
    }),
  })).filter((section) => section.cards.length > 0);
}

/**
 * Resolve an `/admin/*` pathname to the human title of the page it renders.
 *
 * Longest-match wins so `/admin/settings/jobs/insights` resolves to "Job Queue
 * Insights" rather than "Job Queue", and `/admin/settings/nodes/:id/backup`
 * still resolves to its parent's "Worker Nodes" rather than falling back to the
 * hub title. Returns `null` for a path that is not under `/admin`.
 */
export function adminPageTitle(pathname: string): string | null {
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return null;

  let best: { title: string; length: number } | null = null;
  for (const section of ADMIN_SECTIONS) {
    for (const card of section.cards) {
      if (!card.path) continue;
      const matches = pathname === card.path || pathname.startsWith(`${card.path}/`);
      if (matches && (!best || card.path.length > best.length)) {
        best = { title: card.title, length: card.path.length };
      }
    }
  }

  return best?.title ?? ADMIN_HUB_TITLE;
}
