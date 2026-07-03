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
import { Box, Text, render, useApp, useInput } from 'ink';

import { loadConfig, type CliConfig } from '../config.js';
import { openDb } from '../db/database.js';
import { ApiClient, type Circle } from '../api.js';
import { factoryReset } from '../reset.js';
import { SettingsRepo } from '../repo/settings.js';
import { checkForUpdate, compareSemver } from '../version-check.js';
import type BetterSqlite3 from 'better-sqlite3';

import { HomeMenu } from './HomeMenu.js';
import { Menu } from './Menu.js';
import { LoginScreen } from './LoginScreen.js';
import { FolderManager } from './FolderManager.js';
import { CircleManager } from './CircleManager.js';
import { PickFolders } from './PickFolders.js';
import { SyncDashboard } from './SyncDashboard.js';
import { ReportView } from './ReportView.js';
import { SettingsScreen } from './SettingsScreen.js';
import { FactoryResetScreen } from './FactoryResetScreen.js';
import { BackupScreen } from './BackupScreen.js';
import { JobsDashboard } from './JobsDashboard.js';
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
  | { kind: 'pickFolders' }
  | { kind: 'dashboard'; all?: boolean; folderIds?: number[]; retryFailedOnly?: boolean }
  | { kind: 'help' }
  | { kind: 'settings' }
  | { kind: 'factoryReset' }
  | { kind: 'report'; reportId: string }
  | { kind: 'jobs' }
  | { kind: 'backup' };

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

    // Best-effort update check — throttled to once per 24 h via SettingsRepo cache.
    async function checkUpdate(): Promise<void> {
      try {
        const repo = new SettingsRepo(db);
        const cache = repo.getUpdateCheckCache();

        let updateInfo: { updateAvailable: boolean; latestVersion: string | null };

        const cacheIsFresh =
          cache.lastAt !== null &&
          cache.latestVersion !== null &&
          Date.now() - new Date(cache.lastAt).getTime() < 24 * 60 * 60 * 1000;

        if (cacheIsFresh && cache.latestVersion !== null) {
          updateInfo = {
            updateAvailable: compareSemver(cache.latestVersion, currentVersion) > 0,
            latestVersion: cache.latestVersion,
          };
        } else {
          updateInfo = await checkForUpdate(currentVersion);
          if (updateInfo.latestVersion) {
            repo.setUpdateCheckCache(updateInfo.latestVersion);
          }
        }

        if (!cancelled) {
          setAppState((prev) => ({ ...prev, updateInfo }));
        }
      } catch {
        // Never let an update-check failure affect startup.
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
        push({ kind: 'screen', screen: { kind: 'dashboard', all: true } });
        break;
      case 'sync-select':
        push({ kind: 'screen', screen: { kind: 'pickFolders' } });
        break;
      case 'retry':
        push({ kind: 'screen', screen: { kind: 'dashboard', all: true, retryFailedOnly: true } });
        break;
      case 'jobs':
        push({ kind: 'screen', screen: { kind: 'jobs' } });
        break;
      case 'backup':
        push({ kind: 'screen', screen: { kind: 'backup' } });
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

    case 'pickFolders':
      return (
        <PickFolders
          db={db}
          onConfirm={(folderIds) =>
            setStack((prev) => [...prev, { kind: 'screen', screen: { kind: 'dashboard', folderIds } }])
          }
          onBack={pop}
        />
      );

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
          <Text bold color="cyan">MemoriaHub CLI — Help</Text>
          <Text> </Text>
          <Text>Use the interactive menu to manage folders and run syncs.</Text>
          <Text> </Text>
          <Text dimColor>Headless commands (bypass TUI):</Text>
          <Text>  memoriahub login      Configure server + PAT</Text>
          <Text>  memoriahub folders    Manage watched folders</Text>
          <Text>  memoriahub circles    Manage active circle</Text>
          <Text>  memoriahub sync       Run a sync</Text>
          <Text>  memoriahub reports    Show reports (overview, runs, storage, duplicates)</Text>
          <Text>  memoriahub retry      Retry failed files</Text>
          <Text>  memoriahub jobs       Live job queue monitor</Text>
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
  if (!process.stdout.isTTY) {
    process.stdout.write(
      'The interactive UI needs a real terminal. ' +
      'Use `memoriahub sync --all` or `memoriahub --help`.\n',
    );
    return;
  }

  const { waitUntilExit } = render(<App currentVersion={opts?.currentVersion ?? '0.0.0'} />);
  await waitUntilExit();
}
