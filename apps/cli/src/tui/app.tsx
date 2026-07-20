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
import { DateInferenceScreen } from './DateInferenceScreen.js';
import { ConvertScreen } from './ConvertScreen.js';
import { ConvertFileInput } from './ConvertFileInput.js';
import { ReportView } from './ReportView.js';
import { SettingsScreen } from './SettingsScreen.js';
import { FactoryResetScreen } from './FactoryResetScreen.js';
import { BackupScreen } from './BackupScreen.js';
import { JobsDashboard } from './JobsDashboard.js';
import { NodeDashboard } from './NodeDashboard.js';
import { NodeConfig } from './NodeConfig.js';
import { NodeStart } from './NodeStart.js';
import { NodeDoctor } from './NodeDoctor.js';
import { NodeRegister } from './NodeRegister.js';
import { NodeList } from './NodeList.js';
import { NodeLogs } from './NodeLogs.js';
import { NodeService } from './NodeService.js';
import { BOX_BORDER } from './theme.js';
import {
  MENU_TREE,
  findSubmenu,
  visibleChildren,
  breadcrumb,
  type MenuNode,
  type MenuActionId,
} from './menu-config.js';

// ---------------------------------------------------------------------------
// Screen + navigation types
// ---------------------------------------------------------------------------

type Screen =
  | { kind: 'login' }
  | { kind: 'folders' }
  | { kind: 'circles' }
  | { kind: 'pickFolders'; purpose?: 'sync' | 'scan' | 'organize' | 'convert' | 'dateInferDiagnose' | 'dateInferApply' }
  | { kind: 'dateRange'; all?: boolean; folderIds?: number[] }
  | { kind: 'dashboard'; all?: boolean; folderIds?: number[]; retryFailedOnly?: boolean; fromMs?: number; toMs?: number }
  | { kind: 'scan'; all?: boolean; folderIds?: number[] }
  | { kind: 'organize'; all?: boolean; folderIds?: number[] }
  | { kind: 'dateInference'; mode: 'diagnose' | 'apply'; all?: boolean; folderIds?: number[] }
  | { kind: 'convert'; all?: boolean; folderIds?: number[]; files?: string[] }
  | { kind: 'convertFileInput' }
  | { kind: 'scanReport' }
  | { kind: 'help' }
  | { kind: 'settings' }
  | { kind: 'factoryReset' }
  | { kind: 'report'; reportId: string }
  | { kind: 'jobs' }
  | { kind: 'backup' }
  | { kind: 'nodeDashboard' }
  | { kind: 'nodeConfig' }
  | { kind: 'nodeStart' }
  | { kind: 'nodeDoctor' }
  | { kind: 'nodeRegister' }
  | { kind: 'nodeList' }
  | { kind: 'nodeLogs' }
  | { kind: 'nodeService' };

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
// App component
// ---------------------------------------------------------------------------

interface AppState {
  config: CliConfig | null;
  identity: string | null;
  db: BetterSqlite3.Database | null;
  circles: Circle[];
  updateInfo: { updateAvailable: boolean; latestVersion: string | null } | null;
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
  });

  // Load config + db + identity on mount; also fire a throttled update check.
  useEffect(() => {
    const cfg = loadConfig();
    const db  = openDb();

    let cancelled = false;

    async function loadIdentity(): Promise<void> {
      if (!cfg) {
        if (!cancelled) {
          setAppState((prev) => ({ ...prev, config: null, identity: null, db, circles: [] }));
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
          setAppState((prev) => ({ ...prev, config: cfg, identity: me.email ?? null, db, circles }));
        }
      } catch {
        // Not logged in / server unreachable
        if (!cancelled) {
          setAppState((prev) => ({ ...prev, config: cfg, identity: null, db, circles: [] }));
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
      case 'backup':
        push({ kind: 'screen', screen: { kind: 'backup' } });
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
  function toItem(node: MenuNode): { label: string; value: string } {
    if (node.kind === 'submenu') {
      return { label: `${node.label} ▸`, value: `submenu:${node.id}` };
    }
    return { label: node.label, value: `action:${node.action}` };
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
        />
      );
    }

    const submenu = findSubmenu(top.menuId);
    const items = submenu ? visibleChildren(submenu, isLoggedIn).map(toItem) : [];
    return (
      <Menu
        title={breadcrumb(top.menuId)}
        subtitle="Use arrow keys and Enter to navigate"
        items={items}
        onSelect={(value) => selectChild(top.menuId, value)}
        onBack={pop}
      />
    );
  }

  // top.kind === 'screen'
  const screen = top.screen;

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
      return <FolderManager db={db} onBack={pop} />;

    case 'circles':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <CircleManager
          config={config}
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
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <SyncDashboard
          config={config}
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
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <JobsDashboard
          api={new ApiClient(config)}
          intervalMs={5000}
          windowDays={7}
          serverUrl={config.serverUrl}
          onBack={pop}
        />
      );

    case 'backup':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return <BackupScreen config={config} onBack={pop} />;

    case 'nodeDashboard':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <NodeDashboard
          config={config}
          onBack={pop}
          onOpenConfig={() => push({ kind: 'screen', screen: { kind: 'nodeConfig' } })}
        />
      );

    case 'nodeConfig':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <NodeConfig
          config={config}
          onSaved={(cfg) => setAppState((prev) => ({ ...prev, config: cfg }))}
          onBack={pop}
        />
      );

    case 'nodeStart':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <NodeStart
          config={config}
          onStarted={() => replaceTop({ kind: 'screen', screen: { kind: 'nodeDashboard' } })}
          onBack={pop}
        />
      );

    case 'nodeDoctor':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return <NodeDoctor config={config} onBack={pop} />;

    case 'nodeRegister':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return (
        <NodeRegister
          config={config}
          onRegistered={(cfg) => setAppState((prev) => ({ ...prev, config: cfg }))}
          onBack={pop}
        />
      );

    case 'nodeList':
      if (!config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={pop} />
          </Box>
        );
      }
      return <NodeList config={config} onBack={pop} />;

    case 'nodeLogs':
      return <NodeLogs onBack={pop} />;

    case 'nodeService':
      return <NodeService onBack={pop} />;

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
