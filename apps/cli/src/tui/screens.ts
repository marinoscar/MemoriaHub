/**
 * tui/screens.ts — MemoriaHub's screens as platform `registerTuiScreen` data
 * (RETRO-F4, #582). Ink-free: each screen's `load` imports `routes.tsx` (and ink
 * with it) only when the screen is opened, so `--help` and every headless
 * command stay light.
 *
 * One route per 1.3 menu action, same id as the action. A multi-step flow
 * (folder picker, date range, run) is ONE route whose steps are a small view
 * stack inside it (`routes.tsx`), so Esc steps back through the flow exactly as
 * it did in 1.3 and the platform's router sees one screen per menu entry.
 */
import type { TuiScreenProps, TuiScreenRegistration } from '@marinoscar/platform-cli/tui';
import type { ComponentType } from 'react';

import { REPORTS } from '../reports/registry.js';
import { reportRoute } from './menu.js';
import { APP_ANDROID_TUI_SCREEN } from '../extensions/android.js';

type RouteExports = typeof import('./routes.js');
type RouteName = {
  [K in keyof RouteExports]: RouteExports[K] extends ComponentType<TuiScreenProps> ? K : never;
}[keyof RouteExports];

function screen(route: string, label: string, order: number, name: RouteName): TuiScreenRegistration {
  return {
    route,
    label,
    order,
    load: async () => (await import('./routes.js'))[name] as ComponentType<TuiScreenProps>,
  };
}

/** The fixed routes, in the order the 1.3 router handled them. */
const FIXED: readonly [route: string, label: string, name: RouteName][] = [
  ['memoriahub-login', 'Login / Change server', 'LoginRoute'],
  ['sync-all', 'Sync all folders', 'SyncAllRoute'],
  ['sync-select', 'Sync selected folders', 'SyncSelectRoute'],
  ['retry', 'Retry failed files', 'RetryRoute'],
  ['scan-all', 'Scan all folders', 'ScanAllRoute'],
  ['scan-select', 'Scan selected folders', 'ScanSelectRoute'],
  ['scan-report', 'View last scan report', 'ScanReportRoute'],
  ['backup-dashboard', 'Backup', 'BackupRoute'],
  ['node-dashboard', 'Node dashboard', 'NodeDashboardRoute'],
  ['node-start', 'Start worker (background)', 'NodeStartRoute'],
  ['node-stop', 'Stop worker', 'NodeStopRoute'],
  ['node-logs', 'Node logs', 'NodeLogsRoute'],
  ['node-doctor', 'Node doctor', 'NodeDoctorRoute'],
  ['node-enroll', 'Enroll node (login + credential)', 'NodeEnrollRoute'],
  ['node-install-deps', 'Install dependencies (Linux)', 'NodeInstallDepsRoute'],
  ['node-register', 'Register node', 'NodeRegisterRoute'],
  ['node-config', 'Node config', 'NodeConfigRoute'],
  ['node-list', 'List nodes', 'NodeListRoute'],
  ['node-service', 'Node service (systemd)', 'NodeServiceRoute'],
  ['jobs-monitor', 'Job queue monitor', 'JobsMonitorRoute'],
  ['convert-file', 'Convert a single file', 'ConvertFileRoute'],
  ['convert-select', 'Convert selected folder(s)', 'ConvertSelectRoute'],
  ['convert-all', 'Convert all registered folders', 'ConvertAllRoute'],
  ['organize', 'Organize folder by date', 'OrganizeRoute'],
  ['screenshots-find', 'Find screenshots (list only)', 'ScreenshotsFindRoute'],
  ['screenshots-move', 'Find & move screenshots', 'ScreenshotsMoveRoute'],
  ['screenshots-delete', 'Find & delete screenshots', 'ScreenshotsDeleteRoute'],
  ['date-infer-diagnose', 'Diagnose (report only)', 'DateInferDiagnoseRoute'],
  ['date-infer-apply', 'Infer & write dates', 'DateInferApplyRoute'],
  ['folders', 'Manage folders', 'FoldersRoute'],
  ['circles', 'Manage groups', 'CirclesRoute'],
  ['app-settings', 'App settings', 'AppSettingsRoute'],
  ['factory-reset', 'Factory reset (delete all local data)', 'FactoryResetRoute'],
  ['help', 'Help', 'HelpRoute'],
];

export const APP_TUI_SCREENS: readonly TuiScreenRegistration[] = [
  ...FIXED.map(([route, label, name], index) => screen(route, label, index + 1, name)),
  // One route per registered report; the registry stays the single source of truth.
  ...REPORTS.map((report, index) => ({
    route: reportRoute(report.id),
    label: report.label,
    order: FIXED.length + index + 1,
    load: async () => (await import('./routes.js')).reportRouteFor(report.id),
  })),
  // The platform's Android screen (RETRO-D5, #586), at the route the menu entry names.
  { ...APP_ANDROID_TUI_SCREEN, label: 'Android app (build, publish, releases)' },
];
