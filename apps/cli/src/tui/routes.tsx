/**
 * tui/routes.tsx — the route components of MemoriaHub's TUI (RETRO-F4, #582).
 *
 * The platform TUI framework owns the menu, the navigation stack, the login
 * gate, the terminal and the theme. What is left here is the glue between its
 * `TuiScreenProps` ({ onDone, params }) and MemoriaHub's own screens: load the
 * CLI config and the local database, and wire each screen's `onBack` / `onHome`
 * / `onSaved` callbacks to the framework (`onDone` = pop, `nav.toMenu()` = home,
 * `session.refresh()` after anything that changes who is logged in).
 *
 * A multi-step flow (folder picker, date range, run; backup dashboard, verify,
 * settings, login) is ONE route whose steps are a view stack
 * (`useViewStack`), so Esc steps back through the flow as it always did.
 *
 * Loaded lazily by `screens.ts`; importing it pulls ink in.
 */
import { Box, Text, useInput } from './ink.js';
import { useCallback, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { useTuiApp, useTuiState, type TuiScreenProps } from '@marinoscar/platform-cli/tui';

import { ApiClient, type Circle } from '../api.js';
import { loadConfig, type CliConfig } from '../config.js';
import { factoryReset } from '../reset.js';
import { readVersion } from '../version.js';
import type { UpdateStatus } from '../version-check.js';
import type { ScreenshotMode } from '../screenshots/screenshot-engine.js';
import { getAppDb, resetAppDb } from './app-state.js';
import { BackupDashboard } from './BackupDashboard.js';
import { BackupSettings } from './BackupSettings.js';
import { BackupVerify } from './BackupVerify.js';
import { CircleManager } from './CircleManager.js';
import { ConvertFileInput } from './ConvertFileInput.js';
import { ConvertScreen } from './ConvertScreen.js';
import { DateInferenceScreen } from './DateInferenceScreen.js';
import { DateRangeFilter } from './DateRangeFilter.js';
import { FactoryResetScreen } from './FactoryResetScreen.js';
import { FolderManager } from './FolderManager.js';
import { JobsDashboard } from './JobsDashboard.js';
import { LoginScreen } from './LoginScreen.js';
import { NodeConfig } from './NodeConfig.js';
import { NodeDashboard } from './NodeDashboard.js';
import { NodeDoctor } from './NodeDoctor.js';
import { NodeEnroll } from './NodeEnroll.js';
import { NodeInstallDeps } from './NodeInstallDeps.js';
import { NodeList } from './NodeList.js';
import { NodeLogs } from './NodeLogs.js';
import { NodeRegister } from './NodeRegister.js';
import { NodeService } from './NodeService.js';
import { NodeStart } from './NodeStart.js';
import { NodeStop } from './NodeStop.js';
import { OrganizeScreen } from './OrganizeScreen.js';
import { PickFolders } from './PickFolders.js';
import { ReportView } from './ReportView.js';
import { ScanScreen } from './ScanScreen.js';
import { ScreenshotsScreen } from './ScreenshotsScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import { SyncDashboard } from './SyncDashboard.js';

// ---------------------------------------------------------------------------
// Shared glue
// ---------------------------------------------------------------------------

/** A step stack inside one route: `pop` leaves the route when only the first step is left. */
export function useViewStack<V>(initial: V, leave: () => void): {
  view: V;
  push: (view: V) => void;
  replace: (view: V) => void;
  pop: () => void;
} {
  const [stack, setStack] = useState<V[]>([initial]);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const push = useCallback((view: V) => setStack((prev) => [...prev, view]), []);
  const replace = useCallback((view: V) => setStack((prev) => [...prev.slice(0, -1), view]), []);
  const pop = useCallback(() => {
    if (stack.length > 1) setStack((prev) => prev.slice(0, -1));
    else leaveRef.current();
  }, [stack.length]);
  return { view: stack[stack.length - 1] as V, push, replace, pop };
}

/**
 * The CLI config as the screens use it, read once when the route mounts and kept in
 * state so a screen that saves a new one (node config, circles, enroll) updates the
 * route. A route that needs a login shows the shared notice when there is none.
 */
function useCliConfig(): [CliConfig | null, (config: CliConfig | null) => void] {
  return useState<CliConfig | null>(() => loadConfig());
}

/** What the 1.3 app drew in place of a login-required screen with no config. */
function NotLoggedInNotice({ onBack, onLogin }: { onBack: () => void; onLogin?: () => void }): ReactElement {
  useInput((input, key) => {
    if (input === 'l' && onLogin) onLogin();
    else if (key.escape || input === 'q') onBack();
  });
  return (
    <Box paddingX={1} flexDirection="column" gap={1}>
      <Text color="yellow">Not logged in. Please login first.</Text>
      <Text dimColor>{onLogin ? '[l] login   [q/Esc] back' : '[q/Esc] back'}</Text>
    </Box>
  );
}

/** Renders `children(config)` when a config exists, else the not-logged-in notice. */
function RequireConfig({
  config,
  onDone,
  children,
}: {
  config: CliConfig | null;
  onDone: () => void;
  children: (config: CliConfig) => ReactElement;
}): ReactElement {
  const { nav } = useTuiApp();
  if (!config) return <NotLoggedInNotice onBack={onDone} onLogin={() => nav.push('memoriahub-login')} />;
  return children(config);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function LoginRoute({ onDone }: TuiScreenProps): ReactElement {
  const { session, nav } = useTuiApp();
  return (
    <LoginScreen
      initialConfig={loadConfig()}
      onDone={() => {
        // Re-read who is logged in (identity, circle chip), then go home as the 1.3 app did.
        void session.refresh().finally(() => nav.toMenu());
      }}
      onBack={onDone}
    />
  );
}

// ---------------------------------------------------------------------------
// Folder flows: pick folders -> (date range) -> run
// ---------------------------------------------------------------------------

type Purpose =
  | 'sync'
  | 'scan'
  | 'organize'
  | 'convert'
  | 'dateInferDiagnose'
  | 'dateInferApply'
  | 'screenshotsFind'
  | 'screenshotsMove'
  | 'screenshotsDelete';

const PICK_TITLES: Partial<Record<Purpose, string>> = {
  scan: 'Scan Selected Folders',
  organize: 'Organize Folders by Date',
  convert: 'Convert Videos to MP4',
  dateInferDiagnose: 'Date Inference — Select Folders',
  dateInferApply: 'Date Inference — Select Folders',
  screenshotsFind: 'Find Screenshots — Select Folders',
  screenshotsMove: 'Move Screenshots — Select Folders',
  screenshotsDelete: 'Delete Screenshots — Select Folders',
};

const SCREENSHOT_MODES: Partial<Record<Purpose, ScreenshotMode>> = {
  screenshotsFind: 'find',
  screenshotsMove: 'move',
  screenshotsDelete: 'delete',
};

type FlowView =
  | { kind: 'pick' }
  | { kind: 'file-input' }
  | { kind: 'range'; all?: boolean; folderIds?: number[] }
  | { kind: 'run'; all?: boolean; folderIds?: number[]; files?: string[]; fromMs?: number; toMs?: number; retry?: boolean };

function FolderFlow({ purpose, initial, onDone }: { purpose: Purpose; initial: FlowView; onDone: () => void }): ReactElement {
  const { nav } = useTuiApp();
  const db = getAppDb();
  const [config] = useCliConfig();
  const steps = useViewStack<FlowView>(initial, onDone);
  const home = (): void => nav.toMenu();
  const view = steps.view;

  if (view.kind === 'pick') {
    const title = PICK_TITLES[purpose];
    return (
      <PickFolders
        db={db}
        {...(title ? { title } : {})}
        onConfirm={(folderIds) =>
          steps.push(purpose === 'sync' ? { kind: 'range', folderIds } : { kind: 'run', folderIds })
        }
        onBack={steps.pop}
      />
    );
  }

  if (view.kind === 'file-input') {
    return <ConvertFileInput onConfirm={(absPath) => steps.push({ kind: 'run', files: [absPath] })} onBack={steps.pop} />;
  }

  if (view.kind === 'range') {
    return (
      <DateRangeFilter
        onApply={(range) =>
          steps.push({ kind: 'run', all: view.all, folderIds: view.folderIds, fromMs: range.fromMs, toMs: range.toMs })
        }
        onBack={steps.pop}
      />
    );
  }

  switch (purpose) {
    case 'sync':
      return (
        <RequireConfig config={config} onDone={steps.pop}>
          {(cfg) => (
            <SyncDashboard
              config={cfg}
              db={db}
              all={view.all}
              folderIds={view.folderIds}
              retryFailedOnly={view.retry}
              fromMs={view.fromMs}
              toMs={view.toMs}
              onHome={home}
            />
          )}
        </RequireConfig>
      );
    case 'scan':
      return <ScanScreen db={db} all={view.all} folderIds={view.folderIds} onHome={home} onBack={steps.pop} />;
    case 'organize':
      return <OrganizeScreen db={db} all={view.all} folderIds={view.folderIds} onHome={home} onBack={steps.pop} />;
    case 'convert':
      return (
        <ConvertScreen db={db} all={view.all} folderIds={view.folderIds} files={view.files} onHome={home} onBack={steps.pop} />
      );
    case 'dateInferDiagnose':
    case 'dateInferApply':
      return (
        <DateInferenceScreen
          db={db}
          mode={purpose === 'dateInferApply' ? 'apply' : 'diagnose'}
          all={view.all}
          folderIds={view.folderIds}
          onHome={home}
          onBack={steps.pop}
        />
      );
    case 'screenshotsFind':
    case 'screenshotsMove':
    case 'screenshotsDelete':
      return (
        <ScreenshotsScreen
          db={db}
          mode={SCREENSHOT_MODES[purpose] ?? 'find'}
          all={view.all}
          folderIds={view.folderIds}
          onHome={home}
          onBack={steps.pop}
        />
      );
  }
}

/** A route whose first step is the folder picker. */
const pickRoute = (purpose: Purpose) =>
  function PickFlowRoute({ onDone }: TuiScreenProps): ReactElement {
    return <FolderFlow purpose={purpose} initial={{ kind: 'pick' }} onDone={onDone} />;
  };

/** A route that starts at a given step with no folder pick (all folders). */
const startRoute = (purpose: Purpose, initial: FlowView) =>
  function StartFlowRoute({ onDone }: TuiScreenProps): ReactElement {
    return <FolderFlow purpose={purpose} initial={initial} onDone={onDone} />;
  };

export const SyncAllRoute = startRoute('sync', { kind: 'range', all: true });
export const SyncSelectRoute = pickRoute('sync');
export const RetryRoute = startRoute('sync', { kind: 'run', all: true, retry: true });
export const ScanAllRoute = startRoute('scan', { kind: 'run', all: true });
export const ScanSelectRoute = pickRoute('scan');
export const ConvertFileRoute = startRoute('convert', { kind: 'file-input' });
export const ConvertSelectRoute = pickRoute('convert');
export const ConvertAllRoute = startRoute('convert', { kind: 'run', all: true });
export const OrganizeRoute = pickRoute('organize');
export const ScreenshotsFindRoute = pickRoute('screenshotsFind');
export const ScreenshotsMoveRoute = pickRoute('screenshotsMove');
export const ScreenshotsDeleteRoute = pickRoute('screenshotsDelete');
export const DateInferDiagnoseRoute = pickRoute('dateInferDiagnose');
export const DateInferApplyRoute = pickRoute('dateInferApply');

export function ScanReportRoute({ onDone }: TuiScreenProps): ReactElement {
  const { nav } = useTuiApp();
  return <ScanScreen db={getAppDb()} mode="view" onHome={() => nav.toMenu()} onBack={onDone} />;
}

// ---------------------------------------------------------------------------
// Reports and the live job monitor
// ---------------------------------------------------------------------------

const reportRoutes = new Map<string, ComponentType<TuiScreenProps>>();

/** The route component for one registered report (stable identity per id). */
export function reportRouteFor(reportId: string): ComponentType<TuiScreenProps> {
  let component = reportRoutes.get(reportId);
  if (!component) {
    component = function ReportRoute({ onDone }: TuiScreenProps): ReactElement {
      return <ReportView db={getAppDb()} reportId={reportId} onBack={onDone} />;
    };
    reportRoutes.set(reportId, component);
  }
  return component;
}

export function JobsMonitorRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) => (
        <JobsDashboard api={new ApiClient(cfg)} intervalMs={5000} windowDays={7} serverUrl={cfg.serverUrl} onBack={onDone} />
      )}
    </RequireConfig>
  );
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

type BackupView = 'dashboard' | 'verify' | 'settings';

export function BackupRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  const steps = useViewStack<BackupView>('dashboard', onDone);
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) =>
        steps.view === 'verify' ? (
          <BackupVerify onBack={steps.pop} />
        ) : steps.view === 'settings' ? (
          <BackupSettings config={cfg} onBack={steps.pop} />
        ) : (
          <BackupDashboard
            config={cfg}
            onBack={steps.pop}
            onOpenVerify={() => steps.push('verify')}
            onOpenSettings={() => steps.push('settings')}
          />
        )
      }
    </RequireConfig>
  );
}

// ---------------------------------------------------------------------------
// Worker node
// ---------------------------------------------------------------------------

type NodeView = 'dashboard' | 'config' | 'start';

export function NodeDashboardRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config, setConfig] = useCliConfig();
  const steps = useViewStack<NodeView>('dashboard', onDone);
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) =>
        steps.view === 'config' ? (
          <NodeConfig config={cfg} onSaved={setConfig} onBack={steps.pop} />
        ) : (
          <NodeDashboard config={cfg} onBack={steps.pop} onOpenConfig={() => steps.push('config')} />
        )
      }
    </RequireConfig>
  );
}

export function NodeStartRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  const [started, setStarted] = useState(false);
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) =>
        started ? (
          // Start worker -> dashboard on success (the 1.3 `replaceTop`), Esc then leaves to the menu.
          <NodeDashboard config={cfg} onBack={onDone} />
        ) : (
          <NodeStart config={cfg} onStarted={() => setStarted(true)} onBack={onDone} />
        )
      }
    </RequireConfig>
  );
}

export function NodeStopRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  return <NodeStop config={config} onBack={onDone} />;
}

export function NodeLogsRoute({ onDone }: TuiScreenProps): ReactElement {
  return <NodeLogs onBack={onDone} />;
}

export function NodeDoctorRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  return <RequireConfig config={config} onDone={onDone}>{(cfg) => <NodeDoctor config={cfg} onBack={onDone} />}</RequireConfig>;
}

export function NodeEnrollRoute({ onDone }: TuiScreenProps): ReactElement {
  const { session } = useTuiApp();
  const [config] = useCliConfig();
  return (
    <NodeEnroll
      config={config}
      onEnrolled={() => {
        void session.refresh();
        onDone();
      }}
      onBack={onDone}
    />
  );
}

export function NodeInstallDepsRoute({ onDone }: TuiScreenProps): ReactElement {
  return <NodeInstallDeps onBack={onDone} />;
}

export function NodeRegisterRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config, setConfig] = useCliConfig();
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) => <NodeRegister config={cfg} onRegistered={setConfig} onBack={onDone} />}
    </RequireConfig>
  );
}

export function NodeConfigRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config, setConfig] = useCliConfig();
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) => <NodeConfig config={cfg} onSaved={setConfig} onBack={onDone} />}
    </RequireConfig>
  );
}

export function NodeListRoute({ onDone }: TuiScreenProps): ReactElement {
  const [config] = useCliConfig();
  return <RequireConfig config={config} onDone={onDone}>{(cfg) => <NodeList config={cfg} onBack={onDone} />}</RequireConfig>;
}

export function NodeServiceRoute({ onDone }: TuiScreenProps): ReactElement {
  return <NodeService onBack={onDone} />;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function FoldersRoute({ onDone }: TuiScreenProps): ReactElement {
  const { session } = useTuiApp();
  return (
    <FolderManager
      db={getAppDb()}
      onBack={() => {
        // Re-read the folder count so the first-run hint clears as soon as the first folder is added.
        void session.refresh();
        onDone();
      }}
    />
  );
}

export function CirclesRoute({ onDone }: TuiScreenProps): ReactElement {
  const app = useTuiApp();
  const appRef = useRef(app);
  appRef.current = app;
  const [config, setConfig] = useCliConfig();
  return (
    <RequireConfig config={config} onDone={onDone}>
      {(cfg) => (
        <CircleManager
          config={cfg}
          onConfigChange={(next) => {
            setConfig(next);
            // The header chip follows the active circle straight away.
            const selection = appRef.current.selection['circle'];
            const match = selection?.items.find((item) => (item as Circle).id === next.activeCircleId);
            if (selection && match) selection.select(match);
          }}
          onBack={() => {
            // Re-read the circle list (the user may have created, renamed or left one).
            void appRef.current.session.refresh();
            onDone();
          }}
        />
      )}
    </RequireConfig>
  );
}

export function AppSettingsRoute({ onDone }: TuiScreenProps): ReactElement {
  return <SettingsScreen db={getAppDb()} onBack={onDone} />;
}

export function FactoryResetRoute({ onDone }: TuiScreenProps): ReactElement {
  const { session, nav } = useTuiApp();
  return (
    <FactoryResetScreen
      onConfirm={() => {
        // Close the current DB and delete all local state; the next screen opens a fresh one.
        resetAppDb();
        factoryReset();
        getAppDb();
        void session.refresh().finally(() => nav.toMenu());
      }}
      onCancel={onDone}
    />
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function HelpRoute({ onDone }: TuiScreenProps): ReactElement {
  const update = useTuiState<UpdateStatus>('update-info');
  useInput((input, key) => {
    if (key.escape || input === 'q') onDone();
  });
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={3} paddingY={2}>
      <Text bold color="cyan">MemoriaHub CLI — Help  ·  v{readVersion()}</Text>
      {update?.updateAvailable && (
        <Text color="yellow">
          ⬆ Update available: {update.latestVersion} — run 'git pull' in the MemoriaHub repo and rebuild the CLI
        </Text>
      )}
      <Text> </Text>
      <Text>Use the interactive menu to manage folders, scan, and run syncs.</Text>
      <Text dimColor>Run `memoriahub` (no args) or `memoriahub menu` to open this UI.</Text>
      <Text> </Text>
      <Text dimColor>Navigating the menu:</Text>
      <Text>  ↑/↓ or j/k   move   ·   Enter select   ·   1-9 jump straight to an item</Text>
      <Text>  Esc          back one level (not all the way to the root)   ·   q  quit from the main menu</Text>
      <Text>  ▸ marks a submenu   ·   … marks an action that asks something first</Text>
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
      <Text>  memoriahub node       Worker node: enroll, install-deps, register, start/stop</Text>
      <Text>  memoriahub settings   Manage settings</Text>
      <Text> </Text>
      <Text dimColor>[Esc/q] back</Text>
    </Box>
  );
}
