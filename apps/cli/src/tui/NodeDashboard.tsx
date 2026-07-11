/**
 * tui/NodeDashboard.tsx — Ink live control surface for the worker-node engine.
 *
 * TWO data sources behind one interface (see tui/node-dashboard-source.ts):
 *
 *   ATTACHED — a `memoriahub node start --daemon` process is already running.
 *   The dashboard connects to its NDJSON IPC socket, hydrates from the
 *   `snapshot` greeting, appends the daemon's log tail to the log pane, and
 *   applies live `{kind:'event'}` frames through the same reducer the embedded
 *   mode uses. Detaching (q/unmount) ONLY closes the socket — the daemon keeps
 *   running. Keys: [d] drain, [x] stop daemon (with confirm), [r] doctor, and
 *   after a socket loss [r] retries the connection.
 *
 *   EMBEDDED — no daemon is running. The dashboard OWNS a NodeEngine instance
 *   (constructed with the ApiClient + persisted node config, exactly like
 *   `memoriahub node start`) which is only constructed/started when the
 *   operator presses `s`, so mounting the screen is cheap and never spins up
 *   compute automatically. The engine is stopped on unmount. Keys: [s] start,
 *   [d] drain/stop, [r] doctor.
 *
 * Both modes share the pure reducer in node-dashboard-source.ts, so per-slot
 * job state, counters, history, heartbeat, and the error log update through a
 * single code path.
 *
 * IMPORTANT: this component never statically imports any native model library.
 * It only touches the engine's public event/API surface and the capability
 * probe, both of which load native libs dynamically behind an `any` boundary.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { ApiClient } from '../api.js';
import type { CliConfig } from '../config.js';
import { ComputeDispatcher, NODE_JOB_TYPES } from '../node/capabilities.js';
import { NodeEngine, type NodeEngineOptions } from '../node/node-engine.js';
import { NODE_EV } from '../node/node-events.js';
import { ensureModels } from '../node/models.js';
import { isDaemonRunning } from '../node/ipc-client.js';
import { readPidFile } from '../node/daemon.js';
import { BOX_BORDER } from './theme.js';
import { runNodeDoctorSweep, type DoctorSweepState } from './useNodeDoctorSweep.js';
import {
  appendLogLines,
  createAttachedSource,
  EmbeddedDashboardSource,
  hydrateFromSnapshot,
  initialDashboardState,
  reduceNodeEvent,
  type DashboardSource,
  type DashboardState,
} from './node-dashboard-source.js';

// ---------------------------------------------------------------------------
// Defaults (mirror commands/node.ts)
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 5000;
const DEFAULT_CONCURRENCY = 1;
const HISTORY_ROWS = 10;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeDashboardProps {
  config: CliConfig;
  /** Pop back to the previous screen/menu. */
  onBack: () => void;
  /** Navigate to the node config screen (shown as the `c` keybinding). */
  onOpenConfig?: () => void;
}

// ---------------------------------------------------------------------------
// Local state types
// ---------------------------------------------------------------------------

type SourceMode = 'detecting' | 'attached' | 'embedded';
type EngineState = 'stopped' | 'starting' | 'running' | 'draining';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

/** "2h 13m" / "5m 12s" / "42s" uptime from an ISO anchor. */
function formatUptime(startedAtIso: string | null, nowMs: number): string {
  if (!startedAtIso) return '?';
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return '?';
  let secs = Math.max(0, Math.floor((nowMs - started) / 1000));
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${secs}s`;
  return `${secs}s`;
}

/** "3s ago" / "4m ago" / "2h ago" relative time from an ISO timestamp. */
function relTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const secs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "850ms" / "1.2s" / "2m 5s" duration rendering. */
function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${Math.round(secs - m * 60)}s`;
}

/** Resolve the effective engine options from persisted config + defaults. */
function resolveOptions(config: CliConfig): NodeEngineOptions {
  const concurrency = Math.max(1, config.node?.concurrency ?? DEFAULT_CONCURRENCY);
  const eligibleTypes =
    config.node?.eligibleTypes && config.node.eligibleTypes.length > 0
      ? config.node.eligibleTypes
      : [...NODE_JOB_TYPES];
  const pollIntervalMs = config.node?.pollIntervalMs ?? DEFAULT_POLL_MS;
  return { concurrency, eligibleTypes, pollIntervalMs };
}

// ---------------------------------------------------------------------------
// NodeDashboard component
// ---------------------------------------------------------------------------

export function NodeDashboard({ config, onBack, onOpenConfig }: NodeDashboardProps): React.ReactElement {
  const { exit } = useApp();

  const options = resolveOptions(config);
  const registered = Boolean(config.nodeId);

  // Data source + mode
  const sourceRef = useRef<DashboardSource | null>(null);
  const [mode, setMode] = useState<SourceMode>('detecting');
  const [disconnected, setDisconnected] = useState<boolean>(false);
  const [daemonPid, setDaemonPid] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState<boolean>(false);

  // Embedded-engine lifecycle (unused in attached mode)
  const engineRef = useRef<NodeEngine | null>(null);
  const [engineState, setEngineState] = useState<EngineState>('stopped');

  // All live view state flows through the shared reducer.
  const [dash, setDash] = useState<DashboardState>(() =>
    initialDashboardState(options.concurrency, options.eligibleTypes),
  );

  // 1s ticker so elapsed times + throughput refresh
  const [, setTick] = useState<number>(0);

  // Doctor overlay — runs the full sweep via useNodeDoctorSweep.js (see the
  // module header comment above for why this reuses the shared sweep
  // function rather than mounting <NodeDoctor> directly).
  const [showDoctor, setShowDoctor] = useState<boolean>(false);
  const [doctorSweep, setDoctorSweep] = useState<DoctorSweepState | null>(null);

  const mountedRef = useRef<boolean>(true);

  const pushLog = useCallback((level: 'error' | 'warn' | 'info', msg: string): void => {
    setDash((prev) => appendLogLines(prev, [{ level, msg }]));
  }, []);

  // The single event→state path shared by both modes.
  const applyEvent = useCallback((ev: string, payload: unknown): void => {
    setDash((prev) => reduceNodeEvent(prev, ev, payload, Date.now()));
    if (ev === NODE_EV.STOPPED) {
      // Embedded lifecycle: forget the stopped engine so `s` can start anew.
      const src = sourceRef.current;
      if (src instanceof EmbeddedDashboardSource) src.releaseEngine();
      engineRef.current = null;
      setEngineState('stopped');
    }
  }, []);

  // -------------------------------------------------------------------------
  // Source selection: attach to a running daemon, else embedded fallback
  // -------------------------------------------------------------------------
  const initSource = useCallback(async (): Promise<void> => {
    setMode('detecting');
    setDisconnected(false);

    let attached: DashboardSource | null = null;
    try {
      if (await isDaemonRunning()) {
        attached = await createAttachedSource();
      }
    } catch {
      attached = null; // daemon vanished between probe and connect
    }
    if (!mountedRef.current) {
      attached?.close();
      return;
    }

    if (attached) {
      sourceRef.current = attached;
      setDaemonPid(readPidFile()?.pid ?? null);
      setDash((prev) => {
        let next = hydrateFromSnapshot(
          initialDashboardState(prev.concurrency, prev.eligibleTypes ?? undefined),
          attached.snapshot!,
        );
        next = appendLogLines(next, attached.logTail.map((msg) => ({ level: 'info' as const, msg })));
        return next;
      });
      attached.onEvent(applyEvent);
      attached.onDisconnect(() => {
        if (mountedRef.current) setDisconnected(true);
      });
      setMode('attached');
      return;
    }

    const embedded = new EmbeddedDashboardSource();
    embedded.onEvent(applyEvent);
    sourceRef.current = embedded;
    setMode('embedded');
  }, [applyEvent]);

  useEffect(() => {
    mountedRef.current = true;
    void initSource();
    return () => {
      mountedRef.current = false;
      // Attached: ONLY closes the socket (daemon keeps running).
      // Embedded: stops the in-process engine so no worker is orphaned.
      sourceRef.current?.close();
      sourceRef.current = null;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry attach after a daemon disconnect (on `r`).
  const retryAttach = useCallback((): void => {
    sourceRef.current?.close();
    sourceRef.current = null;
    void initSource();
  }, [initSource]);

  // -------------------------------------------------------------------------
  // Ticker: refresh elapsed times / uptime / throughput every second
  // -------------------------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // -------------------------------------------------------------------------
  // Start the embedded engine (on `s`; embedded mode only)
  // -------------------------------------------------------------------------
  const startEngine = useCallback(async (): Promise<void> => {
    const src = sourceRef.current;
    if (!(src instanceof EmbeddedDashboardSource)) return;
    if (engineRef.current) return;
    if (!config.nodeId) {
      pushLog('error', 'Not registered — run `memoriahub node register` first.');
      return;
    }
    setEngineState('starting');
    const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

    // Best-effort ensure models before processing (mirrors `node start`).
    try {
      const manifest = await api.getModelManifest();
      if (manifest.length > 0) {
        setDash((prev) => ({ ...prev, modelStatus: `Ensuring ${manifest.length} model file(s)…` }));
        const res = await ensureModels(manifest);
        setDash((prev) => ({
          ...prev,
          modelStatus:
            `Models ready in ${res.targetDir} (${res.downloaded.length} downloaded, ` +
            `${res.present.length} present${res.failed.length > 0 ? `, ${res.failed.length} failed` : ''})`,
        }));
        for (const f of res.failed) pushLog('warn', `model ${f.name}: ${f.error}`);
      } else {
        setDash((prev) => ({ ...prev, modelStatus: 'No model files listed in the server manifest.' }));
      }
    } catch (err) {
      setDash((prev) => ({
        ...prev,
        modelStatus: `Model manifest unavailable: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }

    const engine = new NodeEngine({
      api,
      dispatcher: new ComputeDispatcher(),
      nodeId: config.nodeId,
      options,
    });
    src.attachEngine(engine);
    engineRef.current = engine;
    setDash((prev) => ({ ...prev, stopped: false }));
    setEngineState('running');

    // start() resolves only after stop(); don't await it in the handler.
    void engine
      .start()
      .catch((err) => {
        pushLog('error', `engine crashed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (mountedRef.current) setEngineState('stopped');
      });
  }, [config, options, pushLog]);

  // -------------------------------------------------------------------------
  // Drain / stop (mode-dependent)
  // -------------------------------------------------------------------------
  const drainOrStop = useCallback((): void => {
    const src = sourceRef.current;
    if (!src) return;
    if (src.mode === 'attached') {
      // Graceful drain of the daemon: stop claiming, finish in-flight.
      src.drain();
      pushLog('info', 'drain requested — daemon stops claiming, finishes in-flight jobs');
    } else {
      if (!engineRef.current) return;
      setEngineState('draining');
      src.stop();
    }
  }, [pushLog]);

  const stopDaemon = useCallback((): void => {
    const src = sourceRef.current;
    if (!src || src.mode !== 'attached') return;
    src.stop();
    pushLog('info', 'stop requested — daemon is shutting down');
  }, [pushLog]);

  // -------------------------------------------------------------------------
  // Run doctor overlay (on `r`) — the FULL sweep (API access, installed
  // capabilities, real operational self-tests, job-type readiness, models,
  // daemon liveness), not just the old presence-only detectCapabilities()
  // probe. See useNodeDoctorSweep.js for the step list and rationale.
  // -------------------------------------------------------------------------
  const runDoctor = useCallback(async (): Promise<void> => {
    setShowDoctor(true);
    setDoctorSweep(null);
    try {
      const api = new ApiClient(config);
      await runNodeDoctorSweep(api, config, (state) => {
        if (mountedRef.current) setDoctorSweep(state);
      });
    } catch (err) {
      pushLog('error', `doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config, pushLog]);

  // -------------------------------------------------------------------------
  // Key handling
  // -------------------------------------------------------------------------
  useInput((input, key) => {
    if (showDoctor) {
      if (key.escape || input === 'q' || input === 'r') setShowDoctor(false);
      return;
    }
    if (confirmStop) {
      if (input === 'y') {
        setConfirmStop(false);
        stopDaemon();
      } else if (input === 'n' || key.escape || input === 'q') {
        setConfirmStop(false);
      }
      return;
    }
    if (input === 's' && mode === 'embedded') {
      void startEngine();
    } else if (input === 'd') {
      drainOrStop();
    } else if (input === 'x' && mode === 'attached' && !disconnected) {
      setConfirmStop(true);
    } else if (input === 'r') {
      if (mode === 'attached' && disconnected) {
        retryAttach();
      } else {
        void runDoctor();
      }
    } else if (input === 'c' && onOpenConfig) {
      onOpenConfig();
    } else if (input === 'q' || key.escape) {
      // Attached: unmount cleanup only closes the socket (daemon keeps running).
      // Embedded: unmount cleanup drains the engine.
      onBack ? onBack() : exit();
    }
  });

  // -------------------------------------------------------------------------
  // Derived render values
  // -------------------------------------------------------------------------
  const active = Object.values(dash.activeJobs);
  const inFlight = active.length;
  const now = Date.now();
  const jobsPerMin = dash.completions.filter((t) => now - t <= 60_000).length;
  const eligibleTypes = dash.eligibleTypes ?? options.eligibleTypes;
  const slotCount = Math.max(dash.concurrency, inFlight);

  // Connection status label + color
  let connLabel: string;
  let connColor: string;
  if (mode === 'detecting') {
    connLabel = 'detecting…';
    connColor = 'yellow';
  } else if (mode === 'attached') {
    if (disconnected) {
      connLabel = 'daemon disconnected';
      connColor = 'red';
    } else if (dash.stopped) {
      connLabel = 'daemon stopped';
      connColor = 'gray';
    } else if (dash.draining) {
      connLabel = 'draining';
      connColor = 'yellow';
    } else if (dash.heartbeat.ok) {
      connLabel = 'online';
      connColor = 'green';
    } else {
      connLabel = 'no heartbeat';
      connColor = 'red';
    }
  } else if (engineState === 'stopped') {
    connLabel = 'stopped';
    connColor = 'gray';
  } else if (engineState === 'starting') {
    connLabel = 'starting…';
    connColor = 'yellow';
  } else if (dash.heartbeat.ok) {
    connLabel = engineState === 'draining' ? 'draining' : 'online';
    connColor = engineState === 'draining' ? 'yellow' : 'green';
  } else {
    connLabel = 'no heartbeat';
    connColor = 'red';
  }

  const hbLabel = dash.heartbeat.at
    ? `${hhmmss(new Date(dash.heartbeat.at))}${dash.heartbeat.ok ? '' : ' (failing)'}`
    : 'never';

  const slotIdleLabel =
    mode === 'attached'
      ? dash.idle
        ? 'idle — waiting for work'
        : 'waiting for work'
      : engineState === 'running'
        ? dash.idle
          ? 'idle — waiting for work'
          : 'waiting for work'
        : 'idle';

  const recentHistory = [...dash.history].slice(-HISTORY_ROWS).reverse();

  // -------------------------------------------------------------------------
  // Doctor overlay render
  // -------------------------------------------------------------------------
  if (showDoctor) {
    const sweeping = !doctorSweep || !doctorSweep.done;
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Doctor</Text>
        {sweeping && (
          <Box marginTop={1}>
            <Text color="cyan">
              <Spinner type="dots" /> {doctorSweep?.currentStep ? `running: ${doctorSweep.currentStep}…` : 'starting…'}
            </Text>
          </Box>
        )}
        {doctorSweep?.caps && doctorSweep.operationalCaps && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text bold dimColor>{'Capability'.padEnd(14)}</Text>
              <Text bold dimColor>{'Installed'.padEnd(11)}</Text>
              <Text bold dimColor>{'Operational'.padEnd(13)}</Text>
              <Text bold dimColor>Detail</Text>
            </Box>
            {Object.entries(doctorSweep.caps).map(([key, status]) => {
              const op = doctorSweep.operationalCaps![key] ?? status;
              let opLabel: string;
              let opColor: string | undefined;
              if (!status.available) {
                opLabel = 'n/a';
                opColor = undefined;
              } else if (op.available) {
                opLabel = 'yes';
                opColor = 'green';
              } else {
                opLabel = 'not yet';
                opColor = 'yellow';
              }
              return (
                <Box key={key} flexDirection="row">
                  <Text>{key.padEnd(14)}</Text>
                  <Text color={status.available ? 'green' : 'red'}>
                    {(status.available ? 'yes' : 'no').padEnd(11)}
                  </Text>
                  <Text color={opColor} dimColor={opColor === undefined}>
                    {opLabel.padEnd(13)}
                  </Text>
                  <Text dimColor>{truncate(op.detail ?? status.detail ?? '', 40)}</Text>
                </Box>
              );
            })}
          </Box>
        )}
        {doctorSweep?.jobReadiness && (
          <Box flexDirection="column" marginTop={1}>
            {doctorSweep.jobReadiness.map((row) => (
              <Text key={row.type} color={row.ready ? 'green' : 'red'}>
                {row.ready ? '✔' : '✖'} {row.type}
                {!row.ready && <Text dimColor> — missing {row.missing.join(', ')}</Text>}
              </Text>
            ))}
          </Box>
        )}
        {doctorSweep?.done && (
          <Box marginTop={1}>
            {doctorSweep.hasError ? (
              <Text color="red" bold>✖ Doctor found problems.</Text>
            ) : (
              <Text color="green" bold>✔ Doctor: all checks passed.</Text>
            )}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>[r/Esc/q] close</Text>
        </Box>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------
  return (
    <Box flexDirection="column" gap={1}>

      {/* Header */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Box flexDirection="row">
          <Text bold color="cyan">MemoriaHub — Worker Node</Text>
          <Text dimColor>  {config.node?.name ?? '(unnamed)'}</Text>
          <Text dimColor>  {config.nodeId ? shortId(config.nodeId) : '(not registered)'}</Text>
          <Text>  status: <Text color={connColor}>{connLabel}</Text></Text>
          {dash.draining && !disconnected ? <Text color="yellow" bold>  ⏸ DRAINING</Text> : null}
        </Box>
        <Box flexDirection="row">
          {mode === 'attached' ? (
            <Text>
              <Text bold color={disconnected ? 'red' : 'magenta'}>ATTACHED</Text>
              <Text dimColor>
                {' '}to daemon (pid {daemonPid ?? '?'} · up {formatUptime(dash.startedAt, now)})
              </Text>
            </Text>
          ) : mode === 'embedded' ? (
            <Text>
              <Text bold color="blue">EMBEDDED</Text>
              <Text dimColor>
                {' '}— no daemon running; press s to start in-process, or run `memoriahub node start --daemon`
              </Text>
            </Text>
          ) : (
            <Text dimColor><Spinner type="dots" /> checking for a running daemon…</Text>
          )}
        </Box>
        <Box flexDirection="row">
          <Text dimColor>heartbeat: </Text>
          <Text
            color={
              dash.heartbeat.ok
                ? 'green'
                : mode === 'embedded' && engineState === 'stopped'
                  ? 'gray'
                  : dash.heartbeat.at
                    ? 'red'
                    : 'gray'
            }
          >
            {hbLabel}
          </Text>
          <Text dimColor>   concurrency: {dash.concurrency}</Text>
          <Text dimColor>   poll: {options.pollIntervalMs}ms</Text>
        </Box>
        <Box flexDirection="row">
          <Text dimColor>types: {truncate(eligibleTypes.join(', '), 72)}</Text>
        </Box>
      </Box>

      {mode === 'attached' && disconnected && (
        <Box paddingX={2}>
          <Text color="red">
            ✖ Daemon connection lost. Press [r] to reconnect (falls back to embedded if the daemon is gone).
          </Text>
        </Box>
      )}

      {mode === 'embedded' && !registered && (
        <Box paddingX={2}>
          <Text color="yellow">
            ⚠ This machine is not registered. Run `memoriahub node register` before starting.
          </Text>
        </Box>
      )}

      {/* Counters band */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="row" paddingX={2} paddingY={0} gap={3}>
        <Text>In-flight: <Text color="cyan">{inFlight}</Text></Text>
        <Text>Claimed: <Text color="cyan">{dash.counters.claimed}</Text></Text>
        <Text>Succeeded: <Text color="green">{dash.counters.succeeded}</Text></Text>
        <Text>Failed: <Text color={dash.counters.failed > 0 ? 'red' : 'white'}>{dash.counters.failed}</Text></Text>
        <Text>Throughput: <Text color="cyan">{jobsPerMin}</Text><Text dimColor>/min</Text></Text>
      </Box>

      {/* Per-slot rows */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Slots</Text>
        {Array.from({ length: slotCount }, (_, i) => {
          const job = active[i];
          if (job) {
            const elapsed = Math.max(0, Math.floor((now - job.startMs) / 1000));
            const pct = job.fraction > 0 ? ` ${Math.round(job.fraction * 100)}%` : '';
            return (
              <Box key={`slot-${i}`} flexDirection="row" gap={1}>
                <Text dimColor>{String(i + 1).padStart(2)}.</Text>
                <Text color="cyan"><Spinner type="dots" /></Text>
                <Text color="cyan">{job.type.padEnd(22)}</Text>
                <Text dimColor>{job.mediaItemId ? shortId(job.mediaItemId) : shortId(job.jobId)}</Text>
                <Text dimColor>  {elapsed}s{pct}</Text>
              </Box>
            );
          }
          return (
            <Box key={`slot-${i}`} flexDirection="row" gap={1}>
              <Text dimColor>{String(i + 1).padStart(2)}.</Text>
              <Text dimColor>{slotIdleLabel}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Task history */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">History (last {HISTORY_ROWS})</Text>
        {recentHistory.length === 0 && <Text dimColor>No completed jobs yet.</Text>}
        {recentHistory.map((h, i) => (
          <Box key={`${h.jobId}-${h.finishedAt}-${i}`} flexDirection="row" gap={1}>
            <Text color={h.status === 'done' ? 'green' : 'red'}>{h.status === 'done' ? '✔' : '✖'}</Text>
            <Text>{truncate(h.type, 22).padEnd(22)}</Text>
            <Text dimColor>{fmtDuration(h.durationMs).padStart(7)}</Text>
            <Text dimColor>{relTime(h.finishedAt, now).padStart(8)}</Text>
            {h.error ? <Text color="red">  {truncate(h.error, 34)}</Text> : null}
          </Box>
        ))}
      </Box>

      {/* Model status (embedded start flow surfaces model readiness here) */}
      <Box paddingX={2}>
        <Text dimColor>models: </Text>
        <Text dimColor>
          {dash.modelStatus ??
            (mode === 'attached' ? '(managed by the daemon)' : '(not loaded — press s to start)')}
        </Text>
      </Box>

      {/* Log pane (errors / warnings / daemon log tail) */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Log (errors / heartbeat)</Text>
        {dash.log.length === 0 && <Text dimColor>No errors.</Text>}
        {dash.log.map((e) => (
          <Box key={e.id} flexDirection="row" gap={1}>
            <Text dimColor>{hhmmss(e.ts)}</Text>
            <Text color={e.level === 'error' ? 'red' : e.level === 'warn' ? 'yellow' : undefined} dimColor={e.level === 'info'}>
              {e.level === 'error' ? '✖' : e.level === 'warn' ? '⚠' : '·'}
            </Text>
            <Text
              color={e.level === 'error' ? 'red' : e.level === 'warn' ? 'yellow' : undefined}
              dimColor={e.level === 'info'}
            >
              {truncate(e.msg, 70)}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Stop-daemon confirmation */}
      {confirmStop && (
        <Box paddingX={2}>
          <Text color="red" bold>Stop the running daemon (finishes in-flight jobs, then exits)? [y] yes  [n] no</Text>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={2}>
        <Text dimColor>
          {mode === 'attached'
            ? disconnected
              ? `[r] retry connection${onOpenConfig ? '   [c] config' : ''}   [q] back`
              : `[d] drain   [x] stop daemon   [r] doctor${onOpenConfig ? '   [c] config' : ''}   [q] detach`
            : `[s] start   [d] drain/stop   [r] doctor${onOpenConfig ? '   [c] config' : ''}   [q] back`}
        </Text>
      </Box>

    </Box>
  );
}
