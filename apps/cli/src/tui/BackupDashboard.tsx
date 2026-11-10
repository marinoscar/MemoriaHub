/**
 * tui/BackupDashboard.tsx — Ink live control surface for the backup engine
 * (issue #320, epic #308).
 *
 * TWO data sources behind one platform `DashboardSource` (see
 * tui/backup-dashboard-source.ts; `useDashboard` starts it on mount and stops it
 * on unmount, RETRO-F4 #582), exactly mirroring NodeDashboard:
 *
 *   ATTACHED — a `memoriahub node start --daemon` process with a bound backup
 *   root is already running. The platform's `daemonAttachFeed` (channel
 *   `backup`) connects to its IPC socket, hydrates from a `backup-status`
 *   reply, and applies live `backup-event` frames through the shared reducer.
 *   Detaching (q/unmount) ONLY closes the socket — the daemon and any
 *   in-flight run keep going.
 *
 *   EMBEDDED — no daemon is running. [r] runs the engine IN THIS PROCESS
 *   through the executeRun() seam, and the run is cancelled on unmount so no
 *   work is orphaned.
 *
 * Keys: [r] run now · [R] reconcile run · [c] cancel · [v] verify · [q] back.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createRequire } from 'node:module';
import { Box, Text, useInput } from './ink.js';
import Spinner from 'ink-spinner';
import { useDashboard } from '@marinoscar/platform-cli/tui';

import type { CliConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { isDaemonRunning } from '../backup/ipc-client.js';
import { executeRun } from '../backup/execute-run.js';
import { resolveRunKind } from '../backup/reconcile.js';
import {
  MAX_LOG,
  applyPendingLag,
  backupDaemonFeed,
  checkpointAgeMs,
  createBackupSource,
  currentBytesPerSec,
  daemonBackupControl,
  embeddedBackupControl,
  embeddedBackupFeed,
  hydrateFromBackupSnapshot,
  initialBackupDashboardState,
  makeBackupLogEntry,
  probeBackupDaemon,
  selectBackupSource,
  type BackupControl,
  type BackupDashboardSource,
  type BackupDashboardState,
  type EmbeddableBackupEngine,
} from './backup-dashboard-source.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** CLI version read from package.json at runtime (same as commands/node.ts). */
function cliVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatAge(ms: number | null): string {
  if (ms === null) return 'never synced';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BackupDashboardProps {
  config: CliConfig;
  onBack: () => void;
  /** Navigate to the verify screen (shown as the `v` keybinding). */
  onOpenVerify?: () => void;
  /** Navigate to the backup settings screen. */
  onOpenSettings?: () => void;
  /** Kick off a run as soon as the source is ready ("Run backup now" menu item). */
  autoRun?: boolean;
}

type SourceMode = 'detecting' | 'attached' | 'embedded';

export function BackupDashboard({
  config,
  onBack,
  onOpenVerify,
  onOpenSettings,
  autoRun,
}: BackupDashboardProps): React.ReactElement {
  const mountedRef = useRef<boolean>(true);
  const [mode, setMode] = useState<SourceMode>('detecting');
  const [, setTick] = useState<number>(0);

  // The platform DashboardSource (attached to a daemon, or following an in-process run) and the
  // controls that go with it. With no source yet the screen draws the empty initial state.
  const [source, setSource] = useState<BackupDashboardSource | undefined>(undefined);
  const controlRef = useRef<BackupControl | null>(null);
  const engineRef = useRef<EmbeddableBackupEngine | null>(null);
  const live = useDashboard(source);
  const emptyState = useMemo(initialBackupDashboardState, []);
  const base: BackupDashboardState = live ?? emptyState;
  const lastStateRef = useRef<BackupDashboardState>(base);
  lastStateRef.current = base;

  // What the dashboard adds to the engine's own state: the server-side pending lag, the optimistic
  // "cancelling" after [c] (the run-finished event resolves it), and its own log lines.
  const [lag, setLag] = useState<{ items: number; bytes: string | number } | null | undefined>(undefined);
  const [cancelRequested, setCancelRequested] = useState<boolean>(false);
  const [notes, setNotes] = useState<BackupDashboardState['log']>([]);
  const dash: BackupDashboardState = useMemo(() => {
    let next = lag === undefined ? base : applyPendingLag(base, lag);
    if (cancelRequested && next.runState === 'running') next = { ...next, runState: 'cancelling' };
    return { ...next, log: [...next.log, ...notes].sort((x, y) => x.id - y.id).slice(-MAX_LOG) };
  }, [base, lag, cancelRequested, notes]);
  useEffect(() => {
    if (base.runState === 'idle') setCancelRequested(false);
  }, [base.runState]);

  // The attached source reconnects by itself; "lost" is only a connection that was up.
  const disconnected = mode === 'attached' && live !== undefined && !live.connected && live.everConnected;

  // Backup binding — read once; a missing root is a hard stop with guidance.
  const bindingRef = useRef<{ root: string | null; nodeId: string | null }>({
    root: null,
    nodeId: null,
  });
  if (bindingRef.current.root === null && bindingRef.current.nodeId === null) {
    try {
      const settings = new SettingsRepo(getDb());
      bindingRef.current = { root: settings.backupRoot(), nodeId: settings.backupNodeId() };
    } catch {
      bindingRef.current = { root: null, nodeId: null };
    }
  }
  const { root, nodeId } = bindingRef.current;
  const configured = Boolean(root && nodeId);

  const pushLog = useCallback((level: 'error' | 'warn' | 'info', msg: string): void => {
    setNotes((prev) => [...prev, makeBackupLogEntry(level, msg, Date.now())].slice(-MAX_LOG));
  }, []);

  // -------------------------------------------------------------------------
  // Embedded run: the executeRun() seam, cancelled on unmount
  // -------------------------------------------------------------------------
  const startEmbeddedRun = useCallback(
    async (kind: 'incremental' | 'reconcile'): Promise<void> => {
      if (!root || !nodeId) return;
      const settings = new SettingsRepo(getDb());
      try {
        await executeRun({
          serverUrl: config.serverUrl,
          pat: config.pat,
          root,
          nodeId,
          kind,
          trigger: 'manual',
          cliVersion: cliVersion(),
          concurrency: Math.max(1, Math.floor(settings.backupConcurrency())),
          maxMbps: settings.backupMaxMbps(),
          pageSize: Math.max(1, Math.floor(settings.backupPageSize())),
          pacingMs: settings.backupPacingMs(),
          retry: settings.retryConfig(),
          cooldown: settings.cooldownConfig(),
          attachRenderer: (engine) => {
            // A fresh source per run, seeded with what is on screen (counters, run history).
            engineRef.current = engine as EmbeddableBackupEngine;
            setSource(createBackupSource(embeddedBackupFeed(engine as EmbeddableBackupEngine), lastStateRef.current));
          },
        });
      } catch (err) {
        if (mountedRef.current) {
          pushLog('error', err instanceof Error ? err.message : String(err));
          setSource(undefined);
        }
      } finally {
        // The run settled: forget the engine (the source keeps the final state on screen).
        engineRef.current?.removeAllListeners();
        engineRef.current = null;
      }
    },
    [config, nodeId, pushLog, root],
  );

  // -------------------------------------------------------------------------
  // Source selection: attach to a running daemon, else embedded fallback
  // -------------------------------------------------------------------------
  const initSource = useCallback(async (): Promise<void> => {
    if (!configured) return;
    setMode('detecting');

    const choice = await selectBackupSource({ isDaemonRunning, probe: () => probeBackupDaemon() });
    if (!mountedRef.current) return;

    if (choice.mode === 'attached') {
      controlRef.current = daemonBackupControl();
      // Seeded from the probe's snapshot, so the first frame shows the catalog and any run in flight
      // while the channel feed connects (it then re-hydrates from the channel's own snapshot).
      setSource(
        createBackupSource(
          backupDaemonFeed(),
          hydrateFromBackupSnapshot(initialBackupDashboardState(), choice.snapshot, Date.now()),
        ),
      );
    } else {
      controlRef.current = embeddedBackupControl({
        start: (kind) => void startEmbeddedRun(kind),
        engine: () => engineRef.current,
      });
    }
    setMode(choice.mode);

    // "Run backup now" lands here with autoRun — but never on top of a run
    // the daemon already has in flight.
    if (autoRun && !(choice.mode === 'attached' && choice.snapshot.running)) {
      controlRef.current.runNow('incremental');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, startEmbeddedRun]);

  useEffect(() => {
    mountedRef.current = true;
    void initSource();
    return () => {
      mountedRef.current = false;
      // Attached: the source's cleanup ONLY closes the socket (daemon + run keep going).
      // Embedded: cancel the in-process run so nothing is orphaned.
      engineRef.current?.cancel();
      engineRef.current = null;
      controlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticker so elapsed time / rate / checkpoint age refresh.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Server-side pending lag: one best-effort fetch on mount.
  useEffect(() => {
    if (!configured || !nodeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
        const { config: cfg } = await api.getNodeBackupConfig(nodeId);
        if (cancelled || !mountedRef.current) return;
        setLag(cfg?.pending ?? null);
      } catch {
        /* offline is fine — the local sections still render */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    if (input === 'v') {
      onOpenVerify?.();
      return;
    }
    if (input === 's') {
      onOpenSettings?.();
      return;
    }
    if (input === 'c') {
      if (dash.runState === 'running') {
        controlRef.current?.cancel();
        setCancelRequested(true);
      }
      return;
    }
    if (input === 'r' || input === 'R') {
      if (dash.runState !== 'idle') return;
      const kind = input === 'R' ? 'reconcile' : 'incremental';
      if (kind === 'incremental' && nodeId) {
        // Honour the same 30-day auto-cadence the CLI applies, so a TUI run
        // is never a weaker guarantee than `memoriahub backup run`.
        void (async () => {
          const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
          const resolved = await resolveRunKind(api, nodeId, false);
          if (!mountedRef.current) return;
          if (resolved.reason === 'auto') {
            pushLog('info', 'last full reconcile is over 30 days old — upgrading to a reconcile run');
          }
          controlRef.current?.runNow(resolved.kind);
        })();
        return;
      }
      controlRef.current?.runNow(kind);
    }
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!configured) {
    return (
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">MemoriaHub — Backup Dashboard</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">No backup root is configured on this machine.</Text>
          <Text> </Text>
          <Text>Bind one first:</Text>
          <Text color="cyan">  memoriahub backup init --dest &lt;dir&gt;</Text>
          <Text> </Text>
          <Text dimColor>[Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  const nowMs = Date.now();
  const rate = currentBytesPerSec(dash, nowMs);
  const running = dash.runState !== 'idle';

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">MemoriaHub — Backup Dashboard</Text>
        <Text dimColor>
          {mode === 'detecting'
            ? 'detecting…'
            : mode === 'attached'
              ? disconnected
                ? 'daemon lost'
                : 'attached to daemon'
              : 'embedded (no daemon)'}
        </Text>
      </Box>
      <Text dimColor>{truncate(root ?? '', 76)}</Text>

      {/* --- State + progress ------------------------------------------- */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          {running ? (
            <Text color="green">
              <Spinner type="dots" />{' '}
            </Text>
          ) : null}
          <Text>
            State: <Text bold color={running ? 'green' : 'gray'}>{dash.runState}</Text>
            {dash.kind ? <Text dimColor>{`  (${dash.kind}${dash.trigger ? `, ${dash.trigger}` : ''})`}</Text> : null}
          </Text>
        </Box>
        {running || dash.progress.items > 0 ? (
          <Text>
            {`  ${dash.progress.items} item(s)  `}
            <Text color="green">{`${dash.progress.downloaded} downloaded`}</Text>
            {`  `}
            <Text dimColor>{`${dash.progress.skipped} up-to-date`}</Text>
            {`  `}
            <Text color={dash.progress.errors > 0 ? 'red' : undefined}>
              {`${dash.progress.errors} failed`}
            </Text>
            {`  ${formatBytes(dash.progress.bytes)} @ ${formatBytes(rate)}/s`}
          </Text>
        ) : null}
        {dash.reconcile ? (
          <Text dimColor>
            {`  Reconcile: ${dash.reconcile.manifestIds} checked, ${dash.reconcile.quarantined} quarantined, ` +
              `${dash.reconcile.driftMarked} to re-download`}
          </Text>
        ) : null}
      </Box>

      {/* --- Catalog / checkpoint / lag ---------------------------------- */}
      <Box marginTop={1} flexDirection="column">
        {dash.counters ? (
          <Text>
            {`Catalog   : ${dash.counters.totalItems} item(s), ${formatBytes(dash.counters.totalBytes)} — ` +
              `${dash.counters.present} present, ${dash.counters.failed} failed, ` +
              `${dash.counters.quarantined} quarantined`}
          </Text>
        ) : null}
        <Text>{`Checkpoint: ${formatAge(checkpointAgeMs(dash, nowMs))}`}</Text>
        {dash.pending ? (
          <Text>
            {`Pending   : ${dash.pending.items} item(s), ${formatBytes(dash.pending.bytes)} behind the server`}
          </Text>
        ) : null}
        {dash.rate ? (
          <Text dimColor>
            {`Rate      : concurrency ${dash.rate.concurrency}, ` +
              `${dash.rate.maxMbps > 0 ? `${dash.rate.maxMbps} Mbps` : 'unlimited'}`}
          </Text>
        ) : null}
      </Box>

      {/* --- Recent runs -------------------------------------------------- */}
      {dash.runs.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Recent runs</Text>
          {dash.runs.slice(0, 5).map((run) => (
            <Text key={run.id} dimColor>
              {`  ${run.startedAt.slice(0, 19)}  ${run.status.padEnd(9)} ${run.kind.padEnd(11)} ` +
                `${run.itemsDownloaded ?? 0} downloaded, ${run.errorCount ?? 0} error(s)`}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* --- Event log ----------------------------------------------------- */}
      {dash.log.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Events</Text>
          {dash.log.slice(-8).map((entry) => (
            <Text
              key={entry.id}
              color={entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : undefined}
              dimColor={entry.level === 'info'}
            >
              {`  ${hhmmss(entry.ts)}  ${truncate(entry.msg, 70)}`}
            </Text>
          ))}
        </Box>
      ) : null}

      {disconnected ? (
        <Box marginTop={1}>
          <Text color="yellow">
            Lost the daemon connection — the run may still be going. Reconnecting automatically…
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          [r] run now · [R] reconcile run · [c] cancel · [v] verify · [s] settings · [Esc/q] back
        </Text>
      </Box>
    </Box>
  );
}
