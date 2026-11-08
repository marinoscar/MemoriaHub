/**
 * tui/menu.ts — MemoriaHub's menu tree as platform `registerTuiMenuNode` data
 * (RETRO-F4, #582). It replaces the 1.3 `menu-config.ts` (`MENU_TREE` and its
 * pure helpers, which now live in `@marinoscar/platform-cli/tui`).
 *
 * Every row of the 1.3 tree is here with the same label, order, logged-out
 * visibility, destructive colour and `…` marker. A leaf's `route` is the 1.3
 * action id (`sync-all`, `node-dashboard`, ...), so the key path to every screen
 * is unchanged. Ink-free: this file is imported by `createCli` on every run.
 *
 * `loggedOut` CASCADES from a section to its descendants (an explicit `false`
 * opts one child out), exactly as it did in 1.3.
 */
import type { TuiMenuNode } from '@marinoscar/platform-cli/tui';

import { REPORTS } from '../reports/registry.js';

/** The route a report entry opens (`report-overview`, ...). */
export function reportRoute(reportId: string): string {
  return `report-${reportId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

/** A section under `parent`. */
function section(
  id: string,
  parent: string | undefined,
  label: string,
  order: number,
  extra: { subtitle?: string; loggedOut?: boolean } = {},
): TuiMenuNode {
  return { kind: 'section', id, ...(parent ? { parent } : {}), label, order, ...extra };
}

/** An entry that opens `route`. */
function entry(
  id: string,
  parent: string | undefined,
  label: string,
  order: number,
  route: string,
  extra: { ellipsis?: boolean; loggedOut?: boolean; hideWhenLoggedIn?: boolean; color?: string } = {},
): TuiMenuNode {
  return { kind: 'entry', id, ...(parent ? { parent } : {}), label, order, route, ...extra };
}

/**
 * The platform's own screens MemoriaHub's menu does not show: its Login keeps the app fields of the
 * config file (`memoriahub-login`), its node group is the 1.3 one until RETRO-C10, and its job
 * monitor is its own (`jobs-monitor`). `createCli({ tuiHiddenScreens })` keeps them off the root
 * menu; they stay routable, but no entry opens them. `deploy` stays listed.
 */
export const PLATFORM_HIDDEN_SCREENS = ['login', 'invoke', 'status', 'jobs', 'node', 'logout'] as const;

/**
 * Root order: Login (logged out only), then the 1.3 root rows, then the platform's
 * `deploy` entry (built-in order 50), with Quit last as the router always draws it.
 * Section and entry orders stay below 50 so `deploy` follows Help.
 */
export const APP_TUI_MENU: readonly TuiMenuNode[] = [
  // Logged out only; once logged in 'Login / Change server' lives under Settings.
  entry('login', undefined, 'Login / Change server', 1, 'memoriahub-login', { loggedOut: true, hideWhenLoggedIn: true }),

  section('sync', undefined, 'Sync', 2),
  entry('sync-all', 'sync', 'Sync all folders', 1, 'sync-all', { ellipsis: true }),
  entry('sync-select', 'sync', 'Sync selected folders', 2, 'sync-select', { ellipsis: true }),
  entry('retry', 'sync', 'Retry failed files', 3, 'retry'),

  // Scan is a fully offline dry-run preview: visible even when logged out.
  section('scan', undefined, 'Scan', 3, {
    subtitle: 'Dry-run preview — reports what a sync would do, without uploading',
    loggedOut: true,
  }),
  entry('scan-all', 'scan', 'Scan all folders', 1, 'scan-all'),
  entry('scan-select', 'scan', 'Scan selected folders', 2, 'scan-select', { ellipsis: true }),
  entry('scan-report', 'scan', 'View last scan report', 3, 'scan-report'),

  // A single leaf straight into the dashboard: run / verify / settings are reachable from inside it.
  entry('backup', undefined, 'Backup', 4, 'backup-dashboard'),

  section('node', undefined, 'Worker Node', 5, { subtitle: 'Daily operations first; first-run setup below' }),
  entry('node-dashboard', 'node', 'Node dashboard', 1, 'node-dashboard'),
  entry('node-start', 'node', 'Start worker (background)', 2, 'node-start'),
  entry('node-stop', 'node', 'Stop worker', 3, 'node-stop'),
  entry('node-logs', 'node', 'Node logs', 4, 'node-logs'),
  entry('node-doctor', 'node', 'Node doctor', 5, 'node-doctor'),
  // ---- first-run setup ----
  entry('node-enroll', 'node', 'Enroll node (login + credential)', 6, 'node-enroll'),
  entry('node-install-deps', 'node', 'Install dependencies (Linux)', 7, 'node-install-deps'),
  entry('node-register', 'node', 'Register node', 8, 'node-register'),
  entry('node-config', 'node', 'Node config', 9, 'node-config'),
  entry('node-list', 'node', 'List nodes', 10, 'node-list'),
  entry('node-service', 'node', 'Node service (systemd)', 11, 'node-service'),

  // The report registry, plus the live job-queue monitor (a live report over the server queue).
  section('reports', undefined, 'Reports', 6),
  ...REPORTS.map((report, index) => entry(reportRoute(report.id), 'reports', report.label, index + 1, reportRoute(report.id))),
  entry('jobs-monitor', 'reports', 'Job queue monitor', REPORTS.length + 1, 'jobs-monitor'),

  // Purely offline local-file utilities: the flag lives here once and cascades.
  section('file-tools', undefined, 'File Tools', 7, {
    subtitle: 'Offline local-file utilities — no server connection required',
    loggedOut: true,
  }),
  section('convert', 'file-tools', 'Convert videos to MP4', 1),
  entry('convert-file', 'convert', 'Convert a single file', 1, 'convert-file', { ellipsis: true }),
  entry('convert-select', 'convert', 'Convert selected folder(s)', 2, 'convert-select', { ellipsis: true }),
  entry('convert-all', 'convert', 'Convert all registered folders', 3, 'convert-all'),
  entry('organize', 'file-tools', 'Organize folder by date', 2, 'organize', { ellipsis: true }),
  section('screenshots', 'file-tools', 'Find/Clean Screenshots', 3),
  entry('screenshots-find', 'screenshots', 'Find screenshots (list only)', 1, 'screenshots-find', { ellipsis: true }),
  entry('screenshots-move', 'screenshots', 'Find & move screenshots', 2, 'screenshots-move', { ellipsis: true }),
  entry('screenshots-delete', 'screenshots', 'Find & delete screenshots', 3, 'screenshots-delete', {
    ellipsis: true,
    color: 'red',
  }),
  section('date-infer', 'file-tools', 'Date Inference', 4),
  entry('date-infer-diagnose', 'date-infer', 'Diagnose (report only)', 1, 'date-infer-diagnose', { ellipsis: true }),
  entry('date-infer-apply', 'date-infer', 'Infer & write dates', 2, 'date-infer-apply', { ellipsis: true }),

  section('settings', undefined, 'Settings', 8),
  entry('folders', 'settings', 'Manage folders', 1, 'folders'),
  entry('circles', 'settings', 'Manage circles', 2, 'circles'),
  entry('app-settings', 'settings', 'App settings', 3, 'app-settings'),
  // Root hides Login once logged in; it stays reachable here to re-authenticate or switch server.
  entry('login-settings', 'settings', 'Login / Change server', 4, 'memoriahub-login'),
  // Building, signing and publishing the Android app: doctor/bump/build work offline.
  entry('android', 'settings', 'Android app (build, publish, releases)', 5, 'android', { loggedOut: true }),
  entry('factory-reset', 'settings', 'Factory reset (delete all local data)', 6, 'factory-reset', {
    loggedOut: true,
    color: 'red',
  }),

  entry('help', undefined, 'Help', 9, 'help', { loggedOut: true }),
];
