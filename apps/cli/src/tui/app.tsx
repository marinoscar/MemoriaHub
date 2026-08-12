/**
 * tui/app.tsx — Root TUI application: hierarchical menu + navigation stack.
 *
 * Navigation is a stack of frames: each frame is either a menu (identified by
 * a submenu id in the menu tree) or a concrete screen. The root frame is the
 * 'root' menu (rendered by HomeMenu with the full banner/identity chrome).
 * Non-root menus render via the generic <Menu>. Every screen's onBack pops one
 * frame instead of jumping straight home, so nesting is preserved.
 *
 * launchTui() checks for a real TTY; if non-TTY it prints a message and
 * returns immediately without hanging. Otherwise it renders <App/> and awaits
 * Ink's waitUntilExit().
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { loadConfig, type CliConfig } from '../config.js';
import { openDb } from '../db/database.js';
import { ApiClient, type Circle } from '../api.js';
import { factoryReset } from '../reset.js';
import { resolveUpdateStatus } from '../version-check.js';
import type BetterSqlite3 from 'better-sqlite3';

import { renderTui } from './raw-mode.js';
import { HomeMenu } from './HomeMenu.js';
import { Menu } from './Menu.js';
import { LoginScreen } from './LoginScreen.js';
import { FolderManager } from './FolderManager.js';
import { CircleManager } from './CircleManager.js';
import { PickFolders } from './PickFolders.js';
import { DateRangeFilter } from './DateRangeFilter.js';
import { SyncDashboard } from './SyncDashboard.js';
import { ScanScreen } from './ScanScreen.js';
import { OrganizeScreen } from './OrganizeScreen.js';
import { ScreenshotsScreen } from './ScreenshotsScreen.js';
import type { ScreenshotMode } from '../screenshots/screenshot-engine.js';
import { DateInferenceScreen } from './DateInferenceScreen.js';
import { ConvertScreen } from './ConvertScreen.js';
import { ConvertFileInput } from './ConvertFileInput.js';
import { ReportView } from './ReportView.js';
import { SettingsScreen } from './SettingsScreen.js';
import { FactoryResetScreen } from './FactoryResetScreen.js';
import { BackupDashboard } from './BackupDashboard.js';
import { BackupVerify } from './BackupVerify.js';
import { BackupSettings } from './BackupSettings.js';
import { JobsDashboard } from './JobsDashboard.js';
import { NodeDashboard } from './NodeDashboard.js';
import { NodeConfig } from './NodeConfig.js';
import { NodeStart } from './NodeStart.js';
import { NodeDoctor } from './NodeDoctor.js';
import { NodeRegister } from './NodeRegister.js';
import { NodeList } from './NodeList.js';
import { NodeLogs } from './NodeLogs.js';
import { NodeService } from './NodeService.js';
import { NodeEnroll } from './NodeEnroll.js';
import { NodeInstallDeps } from './NodeInstallDeps.js';
import { NodeStop } from './NodeStop.js';
import { FolderRepo } from '../repo/folders.js';
import { BOX_BORDER } from './theme.js';
import {
  MENU_TREE,
  findSubmenu,
  visibleChildren,
  breadcrumb,
  menuItemLabel,
  type MenuNode,
  type MenuActionId,
} from './menu-config.js';
import type { MenuListItem } from './MenuList.js';

// ---------------------------------------------------------------------------
// Screen + navigation types
// ---------------------------------------------------------------------------

type Screen =
  | { kind: 'login' }
  | { kind: 'folders' }
  | { kind: 'circles' }
  | { kind: 'pickFolders'; purpose?: 'sync' | 'scan' | 'organize' | 'convert' | 'dateInferDiagnose' | 'dateInferApply' | 'screenshotsFind' | 'screenshotsMove' | 'screenshotsDelete' }
  | { kind: 'dateRange'; all?: boolean; folderIds?: number[] }
  | { kind: 'dashboard'; all?: boolean; folderIds?: number[]; retryFailedOnly?: boolean; fromMs?: number; toMs?: number }
  | { kind: 'scan'; all?: boolean; folderIds?: number[] }
  | { kind: 'organize'; all?: boolean; folderIds?: number[] }
  | { kind: 'screenshots'; mode: ScreenshotMode; all?: boolean; folderIds?: number[] }
  | { kind: 'dateInference'; mode: 'diagnose' | 'apply'; all?: boolean; folderIds?: number[] }
  | { kind: 'convert'; all?: boolean; folderIds?: number[]; files?: string[] }
  | { kind: 'convertFileInput' }
  | { kind: 'scanReport' }
  | { kind: 'help' }
  | { kind: 'settings' }
  | { kind: 'factoryReset' }
  | { kind: 'report'; reportId: string }
  | { kind: 'jobs' }
  | { kind: 'backupDashboard'; autoRun?: boolean }
  | { kind: 'backupVerify' }
  | { kind: 'backupSettings' }
  | { kind: 'nodeDashboard' }
  | { kind: 'nodeConfig' }
  | { kind: 'nodeStart' }
  | { kind: 'nodeDoctor' }
  | { kind: 'nodeRegister' }
  | { kind: 'nodeList' }
  | { kind: 'nodeLogs' }
  | { kind: 'nodeService' }
  | { kind: 'nodeEnroll' }
  | { kind: 'nodeInstallDeps' }
  | { kind: 'nodeStop' };

type NavFrame =
  | { kind: 'menu'; menuId: string }
  | { kind: 'screen'; screen: Screen };

// ---------------------------------------------------------------------------
// Small helper: Esc/q key handler (used on help + not-logged-in fallbacks)
// ---------------------------------------------------------------------------

function KeyHandler({ onBack }: { onBack: () => void }): null {
  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
  });
  return null;
}

// ---------------------------------------------------------------------------
// Login guard
// ---------------------------------------------------------------------------

/**
 * Screens that cannot render without a config. Checked ONCE before the screen
 * switch — this used to be ~10 copies of the same inline `if (!config)` block,
 * where a newly-added screen could simply forget the guard and crash on a
 * null config (issue #413).
 *
 * Deliberately NOT listed: 'nodeEnroll' (it IS the login), 'nodeInstallDeps'
 * (a purely local dependency install), and 'nodeStop' (stops a LOCAL daemon
 * over IPC and only needs a config for its last-resort server-side
 * deregister, which it reports on rather than requiring).
 */
const LOGIN_REQUIRED_SCREENS: ReadonlySet<Screen['kind']> = new Set<Screen['kind']>([
  'circles',
  'dashboard',
  'jobs',
  'backupDashboard',
  'backupSettings',
  'nodeDashboard',
  'nodeConfig',
  'nodeStart',
  'nodeDoctor',
  'nodeRegister',
  'nodeList',
]);

/** Shown in place of a login-required screen when there is no config. */
function NotLoggedIn({ onBack, onLogin }: { onBack: () => void; onLogin: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (input === 'l') onLogin();
    else if (key.escape || input === 'q') onBack();
  });
  return (
    <Box paddingX={1} flexDirection="column" gap={1}>
      <Text color="yellow">Not logged in. Please login first.</Text>
      <Text dimColor>[l] login   [q/Esc] back</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

interface AppState {
  config: CliConfig | null;
  identity: string | null;
  db: BetterSqlite3.Database | null;
  circles: Circle[];
  updateInfo: { updateAvailable: boolean; latestVersion: string | null } | null;
  /** Registered-folder count backing HomeMenu's first-run hint (null = not read yet). */
  folderCount: number | null;
}

function App({ currentVersion }: { currentVersion: string }): React.ReactElement {
  const { exit } = useApp();

  const [stack, setStack] = useState<NavFrame[]>([{ kind: 'menu', menuId: 'root' }]);
  const [appState, setAppState] = useState<AppState>({
    config: null,
    identity: null,
    db: null,
    circles: [],
    updateInfo: null,
    folderCount: null,
  });

  // Load config + db + identity on mount; also fire a throttled update check.
  useEffect(() => {
    const cfg = loadConfig();
    const db  = openDb();

    // Cheap local read — drives HomeMenu's "no folders registered" hint. A
    // failure here must never block the menu, so it degrades to "unknown"
    // (null), which renders no hint at all.
    let folderCount: number | null = null;
    try {
      folderCount = new FolderRepo(db).list().length;
    } catch {
      folderCount = null;
    }

    let cancelled = false;

    async function loadIdentity(): Promise<void> {
      if (!cfg) {
        if (!cancelled) {
          setAppState((prev) => ({ ...prev, config: null, identity: null, db, circles: [], folderCount }));
        }
        return;
      }

      try {
        const api = new ApiClient(cfg);
        const [me, circles] = await Promise.all([
          api.get<{ email?: string }>('/api/auth/me'),
          api.listCircles().catch(() => [] as Circle[]),
        ]);
        if (!cancelled) {
          setAppState((prev) => ({ ...prev, config: cfg, identity: me.email ?? null, db, circles, folderCount }));
        }
      } catch {
        // Not logged in / server unreachable
        if (!cancelled) {
          setAppState((prev) => ({ ...prev, config: cfg, identity: null, db, circles: [], folderCount }));
        }
      }
    }

    // Best-effort update check — the interactive UI checks GitHub live on each
    // launch (force) so the banner/Help always reflect the newest published
    // version rather than a stale cached one. Refreshes the shared cache for
    // the headless notice. Never throws.
    async function checkUpdate(): Promise<void> {
      const updateInfo = await resolveUpdateStatus(db, currentVersion, { force: true });
      if (!cancelled) {
        setAppState((prev) => ({ ...prev, updateInfo }));
      }
    }

    void loadIdentity();
    void checkUpdate();

    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  function push(frame: NavFrame): void {
    setStack((prev) => [...prev, frame]);
  }

  function pop(): void {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  /** Replace the top frame in place (e.g. Start Worker → Dashboard on success). */
  function replaceTop(frame: NavFrame): void {
    setStack((prev) => [...prev.slice(0, -1), frame]);
  }

  function resetToRoot(): void {
    setStack([{ kind: 'menu', menuId: 'root' }]);
  }

  // -------------------------------------------------------------------------
  // Menu selection
  // -------------------------------------------------------------------------

  function openAction(action: MenuActionId): void {
    if (action.startsWith('report:')) {
      push({ kind: 'screen', screen: { kind: 'report', reportId: action.slice('report:'.length) } });
      return;
    }
    switch (action) {
      case 'login':
        push({ kind: 'screen', screen: { kind: 'login' } });
        break;
      case 'folders':
        push({ kind: 'screen', screen: { kind: 'folders' } });
        break;
      case 'circles':
        push({ kind: 'screen', screen: { kind: 'circles' } });
        break;
      case 'app-settings':
        push({ kind: 'screen', screen: { kind: 'settings' } });
        break;
      case 'factory-reset':
        push({ kind: 'screen', screen: { kind: 'factoryReset' } });
        break;
      case 'sync-all':
        push({ kind: 'screen', screen: { kind: 'dateRange', all: true } });
        break;
      case 'sync-select':
        push({ kind: 'screen', screen: { kind: 'pickFolders' } });
        break;
      case 'retry':
        push({ kind: 'screen', screen: { kind: 'dashboard', all: true, retryFailedOnly: true } });
        break;
      case 'scan-all':
        push({ kind: 'screen', screen: { kind: 'scan', all: true } });
        break;
      case 'scan-select':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'scan' } });
        break;
      case 'scan-report':
        push({ kind: 'screen', screen: { kind: 'scanReport' } });
        break;
      case 'organize':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'organize' } });
        break;
      case 'screenshots-find':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'screenshotsFind' } });
        break;
      case 'screenshots-move':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'screenshotsMove' } });
        break;
      case 'screenshots-delete':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'screenshotsDelete' } });
        break;
      case 'date-infer-diagnose':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'dateInferDiagnose' } });
        break;
      case 'date-infer-apply':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'dateInferApply' } });
        break;
      case 'convert-file':
        push({ kind: 'screen', screen: { kind: 'convertFileInput' } });
        break;
      case 'convert-select':
        push({ kind: 'screen', screen: { kind: 'pickFolders', purpose: 'convert' } });
        break;
      case 'convert-all':
        push({ kind: 'screen', screen: { kind: 'convert', all: true } });
        break;
      case 'jobs':
        push({ kind: 'screen', screen: { kind: 'jobs' } });
        break;
      case 'backup-dashboard':
        push({ kind: 'screen', screen: { kind: 'backupDashboard' } });
        break;
      case 'backup-run':
        push({ kind: 'screen', screen: { kind: 'backupDashboard', autoRun: true } });
        break;
      case 'backup-verify':
        push({ kind: 'screen', screen: { kind: 'backupVerify' } });
        break;
      case 'backup-settings':
        push({ kind: 'screen', screen: { kind: 'backupSettings' } });
        break;
      case 'node-dashboard':
        push({ kind: 'screen', screen: { kind: 'nodeDashboard' } });
        break;
      case 'node-config':
        push({ kind: 'screen', screen: { kind: 'nodeConfig' } });
        break;
      case 'node-start':
        push({ kind: 'screen', screen: { kind: 'nodeStart' } });
        break;
      case 'node-doctor':
        push({ kind: 'screen', screen: { kind: 'nodeDoctor' } });
        break;
      case 'node-register':
        push({ kind: 'screen', screen: { kind: 'nodeRegister' } });
        break;
      case 'node-list':
        push({ kind: 'screen', screen: { kind: 'nodeList' } });
        break;
      case 'node-logs':
        push({ kind: 'screen', screen: { kind: 'nodeLogs' } });
        break;
      case 'node-service':
        push({ kind: 'screen', screen: { kind: 'nodeService' } });
        break;
      case 'node-enroll':
        push({ kind: 'screen', screen: { kind: 'nodeEnroll' } });
        break;
      case 'node-install-deps':
        push({ kind: 'screen', screen: { kind: 'nodeInstallDeps' } });
        break;
      case 'node-stop':
        push({ kind: 'screen', screen: { kind: 'nodeStop' } });
        break;
      case 'help':
        push({ kind: 'screen', screen: { kind: 'help' } });
        break;
      case 'quit':
        exit();
        break;
    }
  }

  function handleSelect(node: MenuNode): void {
    if (node.kind === 'submenu') {
      push({ kind: 'menu', menuId: node.id });
    } else {
      openAction(node.action);
    }
  }

  // Encode a menu node into a stable string value for the generic <Menu>.
  // Label decoration (chevron / ellipsis / digit accelerator) lives in
  // menuItemLabel so this renderer and HomeMenu cannot drift.
  function toItem(node: MenuNode, index: number): MenuListItem {
    const label = menuItemLabel(node, index + 1);
    const color = node.color;
    const value = node.kind === 'submenu' ? `submenu:${node.id}` : `action:${node.action}`;
    return color ? { label, value, color } : { label, value };
  }

  function selectChild(menuId: string, value: string): void {
    const submenu = findSubmenu(menuId);
    if (!submenu) return;
    const sep = value.indexOf(':');
    const kind = value.slice(0, sep);
    const rest = value.slice(sep + 1);
    const node = visibleChildren(submenu, isLoggedIn).find((c) =>
      c.kind === 'submenu' ? kind === 'submenu' && c.id === rest : kind === 'action' && c.action === rest,
    );
    if (node) handleSelect(node);
  }

  // -------------------------------------------------------------------------
  // If db not ready yet, show loading
  // -------------------------------------------------------------------------
  if (!appState.db) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  const db = appState.db;
  const { config, identity } = appState;
  const isLoggedIn = Boolean(config && identity);

  const activeCircleName =
    appState.circles.find((c) => c.id === config?.activeCircleId)?.name ?? null;

  // -------------------------------------------------------------------------
  // Render only the TOP frame
  // -------------------------------------------------------------------------
  const top = stack[stack.length - 1];

  if (top.kind === 'menu') {
    if (top.menuId === 'root') {
      return (
        <HomeMenu
          config={config}
          identity={identity}
          activeCircleName={activeCircleName}
          onSelect={handleSelect}
          updateInfo={appState.updateInfo}
          currentVersion={currentVersion}
          folderCount={appState.folderCount ?? undefined}
        />
      );
    }

    const submenu = findSubmenu(top.menuId);
    const items = submenu ? visibleChildren(submenu, isLoggedIn).map(toItem) : [];
    return (
      <Menu
        title={breadcrumb(top.menuId)}
        subtitle={submenu?.subtitle}
        items={items}
        onSelect={(value) => selectChild(top.menuId, value)}
        onBack={pop}
      />
    );
  }

  // top.kind === 'screen'
  const screen = top.screen;

  // Single login gate for every screen that needs a config — see
  // LOGIN_REQUIRED_SCREENS above.
  if (LOGIN_REQUIRED_SCREENS.has(screen.kind) && !config) {
    return (
      <NotLoggedIn
        onBack={pop}
        onLogin={() => replaceTop({ kind: 'screen', screen: { kind: 'login' } })}
      />
    );
  }

  switch (screen.kind) {
    case 'login':
      return (
        <LoginScreen
          initialConfig={config}
          onDone={(cfg) => {
            setAppState((prev) => ({ ...prev, config: cfg }));
            // Re-fetch identity and circles after successful login
            const api = new ApiClient(cfg);
            Promise.all([
              api.get<{ email?: string }>('/api/auth/me'),
              api.listCircles().catch(() => [] as Circle[]),
            ])
              .then(([me, circles]) => {
                setAppState((prev) => ({
                  ...prev,
                  identity: me.email ?? null,
                  circles,
                }));
              })
              .catch(() => {})
              .finally(() => resetToRoot());
          }}
          onBack={pop}
        />
      );

    case 'folders':
      return (
        <FolderManager
          db={db}
          onBack={() => {
            // Re-read the count so HomeMenu's first-run hint clears as soon as
            // the user adds their first folder (and returns if they remove it).
            let folderCount: number | null = null;
            try {
              folderCount = new FolderRepo(db).list().length;
            } catch {
              folderCount = null;
            }
            setAppState((prev) => ({ ...prev, folderCount }));
            pop();
          }}
        />
      );

    case 'circles':
      return (
        <CircleManager
          config={config!}
          onConfigChange={(cfg) => setAppState((prev) => ({ ...prev, config: cfg }))}
          onBack={() => {
            // Refresh circles after returning (user may have changed active circle)
            const cfg = appState.config;
            if (cfg) {
              const api = new ApiClient(cfg);
              api.listCircles().catch(() => [] as Circle[]).then((circles) => {
                setAppState((prev) => ({ ...prev, circles }));
              }).catch(() => {});
            }
            pop();
          }}
        />
      );

    case 'pickFolders': {
      const purpose = screen.purpose ?? 'sync';
      const pickTitle =
        purpose === 'scan'
          ? 'Scan Selected Folders'
          : purpose === 'organize'
            ? 'Organize Folders by Date'
            : purpose === 'convert'
              ? 'Convert Videos to MP4'
              : purpose === 'dateInferDiagnose' || purpose === 'dateInferApply'
                ? 'Date Inference — Select Folders'
                : purpose === 'screenshotsFind'
                  ? 'Find Screenshots — Select Folders'
                  : purpose === 'screenshotsMove'
                    ? 'Move Screenshots — Select Folders'
                    : purpose === 'screenshotsDelete'
                      ? 'Delete Screenshots — Select Folders'
                      : undefined;
      return (
        <PickFolders
          db={db}
          title={pickTitle}
          onConfirm={(folderIds) =>
            setStack((prev) => [
              ...prev,
              {
                kind: 'screen',
                screen:
                  purpose === 'scan'
                    ? { kind: 'scan', folderIds }
                    : purpose === 'organize'
                      ? { kind: 'organize', folderIds }
                      : purpose === 'convert'
                        ? { kind: 'convert', folderIds }
                        : purpose === 'dateInferDiagnose'
                          ? { kind: 'dateInference', mode: 'diagnose', folderIds }
                          : purpose === 'dateInferApply'
                            ? { kind: 'dateInference', mode: 'apply', folderIds }
                            : purpose === 'screenshotsFind'
                              ? { kind: 'screenshots', mode: 'find', folderIds }
                              : purpose === 'screenshotsMove'
                                ? { kind: 'screenshots', mode: 'move', folderIds }
                                : purpose === 'screenshotsDelete'
                                  ? { kind: 'screenshots', mode: 'delete', folderIds }
                                  : { kind: 'dateRange', folderIds },
              },
            ])
          }
          onBack={pop}
        />
      );
    }

    case 'dateRange':
      return (
        <DateRangeFilter
          onApply={(r) =>
            push({
              kind: 'screen',
              screen: {
                kind: 'dashboard',
                all: screen.all,
                folderIds: screen.folderIds,
                fromMs: r.fromMs,
                toMs: r.toMs,
              },
            })
          }
          onBack={pop}
        />
      );

    case 'scan':
      return (
        <ScanScreen
          db={db}
          all={screen.all}
          folderIds={screen.folderIds}
          onHome={resetToRoot}
          onBack={pop}
        />
      );

    case 'organize':
      return (
        <OrganizeScreen
          db={db}
          all={screen.all}
          folderIds={screen.folderIds}
          onHome={resetToRoot}
          onBack={pop}
        />
      );

    case 'screenshots':
      return (
        <ScreenshotsScreen
          db={db}
          mode={screen.mode}
          all={screen.all}
          folderIds={screen.folderIds}
          onHome={resetToRoot}
          onBack={pop}
        />
      );

    case 'dateInference':
      return (
        <DateInferenceScreen
          db={db}
          mode={screen.mode}
          all={screen.all}
          folderIds={screen.folderIds}
          onHome={resetToRoot}
          onBack={pop}
        />
      );

    case 'convert':
      return (
        <ConvertScreen
          db={db}
          all={screen.all}
          folderIds={screen.folderIds}
          files={screen.files}
          onHome={resetToRoot}
          onBack={pop}
        />
      );

    case 'convertFileInput':
      return (
        <ConvertFileInput
          onConfirm={(absPath) =>
            push({ kind: 'screen', screen: { kind: 'convert', files: [absPath] } })
          }
          onBack={pop}
        />
      );

    case 'scanReport':
      return <ScanScreen db={db} mode="view" onHome={resetToRoot} onBack={pop} />;

    case 'dashboard':
      return (
        <SyncDashboard
          config={config!}
          db={db}
          all={screen.all}
          folderIds={screen.folderIds}
          retryFailedOnly={screen.retryFailedOnly}
          fromMs={screen.fromMs}
          toMs={screen.toMs}
          onHome={resetToRoot}
        />
      );

    case 'report':
      return <ReportView db={db} reportId={screen.reportId} onBack={pop} />;

    case 'jobs':
      return (
        <JobsDashboard
          api={new ApiClient(config!)}
          intervalMs={5000}
          windowDays={7}
          serverUrl={config!.serverUrl}
          onBack={pop}
        />
      );

    case 'backupDashboard':
      return (
        <BackupDashboard
          config={config!}
          autoRun={screen.autoRun}
          onBack={pop}
          onOpenVerify={() => push({ kind: 'screen', screen: { kind: 'backupVerify' } })}
          onOpenSettings={() => push({ kind: 'screen', screen: { kind: 'backupSettings' } })}
        />
      );

    case 'backupVerify':
      return <BackupVerify onBack={pop} />;

    case 'backupSettings':
      return <BackupSettings config={config!} onBack={pop} />;

    case 'nodeDashboard':
      return (
        <NodeDashboard
          config={config!}
          onBack={pop}
          onOpenConfig={() => push({ kind: 'screen', screen: { kind: 'nodeConfig' } })}
        />
      );

    case 'nodeConfig':
      return (
        <NodeConfig
          config={config!}
          onSaved={(cfg) => setAppState((prev) => ({ ...prev, config: cfg }))}
          onBack={pop}
        />
      );

    case 'nodeStart':
      return (
        <NodeStart
          config={config!}
          onStarted={() => replaceTop({ kind: 'screen', screen: { kind: 'nodeDashboard' } })}
          onBack={pop}
        />
      );

    case 'nodeDoctor':
      return <NodeDoctor config={config!} onBack={pop} />;

    case 'nodeRegister':
      return (
        <NodeRegister
          config={config!}
          onRegistered={(cfg) => setAppState((prev) => ({ ...prev, config: cfg }))}
          onBack={pop}
        />
      );

    case 'nodeList':
      return <NodeList config={config!} onBack={pop} />;

    case 'nodeLogs':
      return <NodeLogs onBack={pop} />;

    case 'nodeService':
      return <NodeService onBack={pop} />;

    case 'nodeEnroll':
      return (
        <NodeEnroll
          config={config}
          onEnrolled={(cfg) => {
            setAppState((prev) => ({ ...prev, config: cfg }));
            pop();
          }}
          onBack={pop}
        />
      );

    case 'nodeInstallDeps':
      return <NodeInstallDeps onBack={pop} />;

    case 'nodeStop':
      return <NodeStop config={config} onBack={pop} />;

    case 'settings':
      return <SettingsScreen db={db} onBack={pop} />;

    case 'factoryReset':
      return (
        <FactoryResetScreen
          onConfirm={() => {
            // Close the current DB and delete all local state.
            factoryReset();
            // Open a fresh DB so the app stays functional after the reset.
            const freshDb = openDb();
            setAppState({
              config: null,
              identity: null,
              db: freshDb,
              circles: [],
              updateInfo: appState.updateInfo,
              folderCount: 0,
            });
            resetToRoot();
          }}
          onCancel={pop}
        />
      );

    case 'help':
      return (
        <Box
          borderStyle={BOX_BORDER}
          borderColor="cyan"
          flexDirection="column"
          paddingX={3}
          paddingY={2}
        >
          <Text bold color="cyan">MemoriaHub CLI — Help  ·  v{currentVersion}</Text>
          {appState.updateInfo?.updateAvailable && (
            <Text color="yellow">
              ⬆ Update available: {appState.updateInfo.latestVersion} — run 'git pull' in the MemoriaHub repo and rebuild the CLI
            </Text>
          )}
          <Text> </Text>
          <Text>Use the interactive menu to manage folders, scan, and run syncs.</Text>
          <Text dimColor>Run `memoriahub` (no args) or `memoriahub menu` to open this UI.</Text>
          <Text> </Text>
          <Text dimColor>Headless commands (bypass TUI):</Text>
          <Text>  memoriahub login      Configure server + PAT</Text>
          <Text>  memoriahub import     Import a folder once (add + sync)</Text>
          <Text>  memoriahub sync       Run a sync (add --scan to reconcile a prior scan)</Text>
          <Text>  memoriahub scan       Dry-run preview: report what a sync would do</Text>
          <Text>  memoriahub organize   Move files into YEAR/MM - Month/ folders by capture date</Text>
          <Text>  memoriahub screenshots  Find (and optionally move/delete) screenshot files</Text>
          <Text>  memoriahub convert    Convert video files to MP4</Text>
          <Text>  memoriahub status     Show sync status and counts</Text>
          <Text>  memoriahub folders    Manage watched folders</Text>
          <Text>  memoriahub circles    Manage active circle</Text>
          <Text>  memoriahub retry      Retry failed files</Text>
          <Text>  memoriahub jobs       Live job queue monitor</Text>
          <Text>  memoriahub reports    Show reports (overview, runs, storage, duplicates)</Text>
          <Text>  memoriahub backup     Back up circle media to a local folder</Text>
          <Text>  memoriahub settings   Manage settings</Text>
          <Text> </Text>
          <Text dimColor>[Esc/q] back</Text>
          <KeyHandler onBack={pop} />
        </Box>
      );
  }
}

// ---------------------------------------------------------------------------
// launchTui — public entry point
// ---------------------------------------------------------------------------

export async function launchTui(opts?: { currentVersion?: string }): Promise<void> {
  // NOTE: do NOT re-exec here to raise the V8 heap ceiling. A re-exec turns
  // this process into a signal-forwarding shim whose child loses interactive
  // raw-mode control of the terminal (setRawMode EIO), which breaks the TUI on
  // machines where the re-exec fires. Sustained/high-memory worker load has its
  // own tuned, non-interactive path (`memoriahub node start` / the daemon the
  // Worker Node dashboard attaches to), so the lightweight interactive menu
  // stays in-process and untuned.
  await renderTui(<App currentVersion={opts?.currentVersion ?? '0.0.0'} />);
}
