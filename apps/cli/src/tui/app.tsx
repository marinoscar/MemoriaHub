/**
 * tui/app.tsx — Root TUI application: screen state machine + launch entry point.
 *
 * Screens: home | login | folders | pickFolders | dashboard | help | status | settings | factoryReset
 *
 * launchTui() checks for a real TTY; if non-TTY it prints a message and
 * returns immediately without hanging.  Otherwise it renders <App/> and
 * awaits Ink's waitUntilExit().
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import { loadConfig, type CliConfig } from '../config.js';
import { openDb } from '../db/database.js';
import { ApiClient, type Circle } from '../api.js';
import { factoryReset } from '../reset.js';
import type BetterSqlite3 from 'better-sqlite3';

import { HomeMenu, type MenuAction } from './HomeMenu.js';
import { LoginScreen } from './LoginScreen.js';
import { FolderManager } from './FolderManager.js';
import { CircleManager } from './CircleManager.js';
import { PickFolders } from './PickFolders.js';
import { SyncDashboard } from './SyncDashboard.js';
import { StatusScreen } from './StatusScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { FactoryResetScreen } from './FactoryResetScreen.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Screen types
// ---------------------------------------------------------------------------

type Screen =
  | { kind: 'home' }
  | { kind: 'login' }
  | { kind: 'folders' }
  | { kind: 'circles' }
  | { kind: 'pickFolders' }
  | { kind: 'dashboard'; all?: boolean; folderIds?: number[]; retryFailedOnly?: boolean }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'settings' }
  | { kind: 'factoryReset' };

// ---------------------------------------------------------------------------
// Small helper: Esc/q key handler (used on help screen)
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
}

function App(): React.ReactElement {
  const { exit } = useApp();

  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [appState, setAppState] = useState<AppState>({
    config: null,
    identity: null,
    db: null,
    circles: [],
  });

  // Load config + db + identity on mount
  useEffect(() => {
    const cfg = loadConfig();
    const db  = openDb();

    let cancelled = false;

    async function loadIdentity(): Promise<void> {
      if (!cfg) {
        if (!cancelled) setAppState({ config: null, identity: null, db, circles: [] });
        return;
      }

      try {
        const api = new ApiClient(cfg);
        const [me, circles] = await Promise.all([
          api.get<{ email?: string }>('/api/auth/me'),
          api.listCircles().catch(() => [] as Circle[]),
        ]);
        if (!cancelled) {
          setAppState({ config: cfg, identity: me.email ?? null, db, circles });
        }
      } catch {
        // Not logged in / server unreachable
        if (!cancelled) setAppState({ config: cfg, identity: null, db, circles: [] });
      }
    }

    void loadIdentity();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Home menu ----
  function handleMenuSelect(action: MenuAction): void {
    switch (action) {
      case 'login':
        setScreen({ kind: 'login' });
        break;
      case 'folders':
        setScreen({ kind: 'folders' });
        break;
      case 'circles':
        setScreen({ kind: 'circles' });
        break;
      case 'sync-all':
        setScreen({ kind: 'dashboard', all: true });
        break;
      case 'sync-select':
        setScreen({ kind: 'pickFolders' });
        break;
      case 'retry':
        setScreen({ kind: 'dashboard', all: true, retryFailedOnly: true });
        break;
      case 'status':
        setScreen({ kind: 'status' });
        break;
      case 'settings':
        setScreen({ kind: 'settings' });
        break;
      case 'help':
        setScreen({ kind: 'help' });
        break;
      case 'factory-reset':
        setScreen({ kind: 'factoryReset' });
        break;
      case 'quit':
        exit();
        break;
    }
  }

  // ---- If db not ready yet, show loading ----
  if (!appState.db) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  const db = appState.db;

  const activeCircleName =
    appState.circles.find((c) => c.id === appState.config?.activeCircleId)?.name ?? null;

  // ---- Screen routing ----
  switch (screen.kind) {
    case 'home':
      return (
        <HomeMenu
          config={appState.config}
          identity={appState.identity}
          activeCircleName={activeCircleName}
          onSelect={handleMenuSelect}
        />
      );

    case 'login':
      return (
        <LoginScreen
          initialConfig={appState.config}
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
              .finally(() => setScreen({ kind: 'home' }));
          }}
          onBack={() => setScreen({ kind: 'home' })}
        />
      );

    case 'folders':
      return (
        <FolderManager
          db={db}
          onBack={() => setScreen({ kind: 'home' })}
        />
      );

    case 'circles':
      if (!appState.config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={() => setScreen({ kind: 'home' })} />
          </Box>
        );
      }
      return (
        <CircleManager
          config={appState.config}
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
            setScreen({ kind: 'home' });
          }}
        />
      );

    case 'pickFolders':
      return (
        <PickFolders
          db={db}
          onConfirm={(folderIds) => setScreen({ kind: 'dashboard', folderIds })}
          onBack={() => setScreen({ kind: 'home' })}
        />
      );

    case 'dashboard':
      if (!appState.config) {
        return (
          <Box paddingX={1} flexDirection="column" gap={1}>
            <Text color="yellow">Not logged in. Please login first.</Text>
            <Text dimColor>Press q to go back.</Text>
            <KeyHandler onBack={() => setScreen({ kind: 'home' })} />
          </Box>
        );
      }
      return (
        <SyncDashboard
          config={appState.config}
          db={db}
          all={screen.all}
          folderIds={screen.folderIds}
          retryFailedOnly={screen.retryFailedOnly}
          onHome={() => setScreen({ kind: 'home' })}
        />
      );

    case 'status':
      return (
        <StatusScreen
          db={db}
          onBack={() => setScreen({ kind: 'home' })}
        />
      );

    case 'settings':
      return (
        <SettingsScreen
          db={db}
          onBack={() => setScreen({ kind: 'home' })}
        />
      );

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
            });
            setScreen({ kind: 'home' });
          }}
          onCancel={() => setScreen({ kind: 'home' })}
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
          <Text>  memoriahub status     Show sync status</Text>
          <Text>  memoriahub retry      Retry failed files</Text>
          <Text>  memoriahub settings   Manage settings</Text>
          <Text> </Text>
          <Text dimColor>[Esc/q] back to home</Text>
          <KeyHandler onBack={() => setScreen({ kind: 'home' })} />
        </Box>
      );
  }
}

// ---------------------------------------------------------------------------
// launchTui — public entry point
// ---------------------------------------------------------------------------

export async function launchTui(_opts?: Record<string, unknown>): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(
      'The interactive UI needs a real terminal. ' +
      'Use `memoriahub sync --all` or `memoriahub --help`.\n',
    );
    return;
  }

  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
