/**
 * tui/NodeDashboard.tsx — Ink live control surface for the worker-node engine.
 *
 * OWNS a NodeEngine instance (constructed with the ApiClient + persisted node
 * config, exactly like `memoriahub node start`) and renders its typed event
 * stream live: per-slot job state, throughput, counters, model-load status, and
 * a rolling error/heartbeat log.
 *
 * The engine is only constructed/started when the operator presses `s` (start),
 * so mounting the screen is cheap and never spins up compute automatically.
 *
 * Keys:
 *   s       — start the engine (ensure models, then claim/compute loop)
 *   d       — drain & stop the engine
 *   r       — run the capability doctor (overlay)
 *   c       — open node config (when available)
 *   q / Esc — back to the menu (stops the engine on unmount)
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
import {
  ComputeDispatcher,
  detectCapabilities,
  NODE_JOB_TYPES,
  type CapabilityStatus,
} from '../node/capabilities.js';
import { NodeEngine, type NodeEngineOptions } from '../node/node-engine.js';
import { NODE_EV } from '../node/node-events.js';
import { ensureModels } from '../node/models.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Defaults (mirror commands/node.ts)
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 5000;
const DEFAULT_CONCURRENCY = 1;
const MAX_LOG = 15;

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

type EngineState = 'stopped' | 'starting' | 'running' | 'draining';

interface ActiveJob {
  jobId: string;
  type: string;
  mediaItemId: string | null;
  startMs: number;
  fraction: number;
}

interface HeartbeatState {
  ok: boolean;
  at: string | null;
}

type LogLevel = 'error' | 'warn';

interface LogEntry {
  id: number;
  ts: Date;
  level: LogLevel;
  msg: string;
}

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

  // Engine + lifecycle
  const engineRef = useRef<NodeEngine | null>(null);
  const [engineState, setEngineState] = useState<EngineState>('stopped');
  const [idle, setIdle] = useState<boolean>(false);

  // Live state driven by engine events
  const [heartbeat, setHeartbeat] = useState<HeartbeatState>({ ok: false, at: null });
  const [activeJobs, setActiveJobs] = useState<Record<string, ActiveJob>>({});
  const [succeeded, setSucceeded] = useState<number>(0);
  const [failed, setFailed] = useState<number>(0);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Throughput bookkeeping
  const completionsRef = useRef<number[]>([]);
  const [jobsPerMin, setJobsPerMin] = useState<number>(0);

  // 1s ticker so elapsed times + throughput refresh
  const [, setTick] = useState<number>(0);

  // Doctor overlay
  const [showDoctor, setShowDoctor] = useState<boolean>(false);
  const [doctorLoading, setDoctorLoading] = useState<boolean>(false);
  const [doctorReport, setDoctorReport] = useState<Record<string, CapabilityStatus> | null>(null);

  const logIdRef = useRef<number>(0);

  const pushLog = useCallback((level: LogLevel, msg: string): void => {
    setLog((prev) => {
      const entry: LogEntry = { id: ++logIdRef.current, ts: new Date(), level, msg };
      return [...prev, entry].slice(-MAX_LOG);
    });
  }, []);

  // -------------------------------------------------------------------------
  // Ticker: recompute throughput + trigger elapsed re-render every second
  // -------------------------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const recent = completionsRef.current.filter((t) => now - t <= 60_000);
      completionsRef.current = recent;
      setJobsPerMin(recent.length);
      setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // -------------------------------------------------------------------------
  // Cleanup on unmount — drain the engine so no worker is orphaned
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      const e = engineRef.current;
      if (e) {
        e.removeAllListeners();
        void e.stop('unmount');
        engineRef.current = null;
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Attach engine event listeners
  // -------------------------------------------------------------------------
  const attachListeners = useCallback(
    (engine: NodeEngine): void => {
      engine.on(NODE_EV.CLAIMED, () => {
        setIdle(false);
      });
      engine.on(NODE_EV.JOB_START, (p) => {
        setIdle(false);
        setActiveJobs((prev) => ({
          ...prev,
          [p.jobId]: {
            jobId: p.jobId,
            type: p.type,
            mediaItemId: p.mediaItemId ?? null,
            startMs: Date.now(),
            fraction: 0,
          },
        }));
      });
      engine.on(NODE_EV.JOB_PROGRESS, (p) => {
        setActiveJobs((prev) => {
          const job = prev[p.jobId];
          if (!job) return prev;
          return { ...prev, [p.jobId]: { ...job, fraction: p.fraction } };
        });
      });
      engine.on(NODE_EV.JOB_DONE, (p) => {
        completionsRef.current.push(Date.now());
        setSucceeded((n) => n + 1);
        setActiveJobs((prev) => {
          const next = { ...prev };
          delete next[p.jobId];
          return next;
        });
        if (!p.submitted) {
          pushLog('warn', `job ${shortId(p.jobId)} (${p.type}) computed but result endpoint unavailable`);
        }
      });
      engine.on(NODE_EV.JOB_ERROR, (p) => {
        completionsRef.current.push(Date.now());
        setFailed((n) => n + 1);
        setActiveJobs((prev) => {
          const next = { ...prev };
          delete next[p.jobId];
          return next;
        });
        pushLog('error', `job ${shortId(p.jobId)} (${p.type}) failed: ${p.error}`);
      });
      engine.on(NODE_EV.IDLE, () => {
        setIdle(true);
      });
      engine.on(NODE_EV.HEARTBEAT_OK, (p) => {
        setHeartbeat({ ok: true, at: p.at });
      });
      engine.on(NODE_EV.HEARTBEAT_FAIL, (p) => {
        setHeartbeat((prev) => ({ ok: false, at: prev.at }));
        pushLog('error', `heartbeat: ${p.error}`);
      });
      engine.on(NODE_EV.MODEL_LOADED, (p) => {
        setModelStatus(
          `Models loaded from ${p.targetDir} (${p.downloaded} downloaded, ${p.present} present` +
            `${p.failed > 0 ? `, ${p.failed} failed` : ''})`,
        );
      });
      engine.on(NODE_EV.STOPPED, () => {
        setEngineState('stopped');
        setIdle(false);
        setActiveJobs({});
        if (engineRef.current) {
          engineRef.current.removeAllListeners();
          engineRef.current = null;
        }
      });
    },
    [pushLog],
  );

  // -------------------------------------------------------------------------
  // Start the engine (on `s`)
  // -------------------------------------------------------------------------
  const startEngine = useCallback(async (): Promise<void> => {
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
        setModelStatus(`Ensuring ${manifest.length} model file(s)…`);
        const res = await ensureModels(manifest);
        setModelStatus(
          `Models ready in ${res.targetDir} (${res.downloaded.length} downloaded, ` +
            `${res.present.length} present${res.failed.length > 0 ? `, ${res.failed.length} failed` : ''})`,
        );
        for (const f of res.failed) pushLog('warn', `model ${f.name}: ${f.error}`);
      } else {
        setModelStatus('No model files listed in the server manifest.');
      }
    } catch (err) {
      setModelStatus(`Model manifest unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const engine = new NodeEngine({
      api,
      dispatcher: new ComputeDispatcher(),
      nodeId: config.nodeId,
      options,
    });
    attachListeners(engine);
    engineRef.current = engine;
    setEngineState('running');

    // start() resolves only after stop(); don't await it in the handler.
    void engine
      .start()
      .catch((err) => {
        pushLog('error', `engine crashed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        setEngineState('stopped');
        setIdle(false);
      });
  }, [config, options, attachListeners, pushLog]);

  // -------------------------------------------------------------------------
  // Drain & stop the engine (on `d`)
  // -------------------------------------------------------------------------
  const stopEngine = useCallback((): void => {
    const e = engineRef.current;
    if (!e) return;
    setEngineState('draining');
    void e.stop('drain');
  }, []);

  // -------------------------------------------------------------------------
  // Run doctor overlay (on `r`)
  // -------------------------------------------------------------------------
  const runDoctor = useCallback(async (): Promise<void> => {
    setShowDoctor(true);
    setDoctorLoading(true);
    try {
      const caps = await detectCapabilities();
      setDoctorReport(caps);
    } catch (err) {
      pushLog('error', `doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDoctorLoading(false);
    }
  }, [pushLog]);

  // -------------------------------------------------------------------------
  // Key handling
  // -------------------------------------------------------------------------
  useInput((input, key) => {
    if (showDoctor) {
      if (key.escape || input === 'q' || input === 'r') setShowDoctor(false);
      return;
    }
    if (input === 's') {
      void startEngine();
    } else if (input === 'd') {
      stopEngine();
    } else if (input === 'r') {
      void runDoctor();
    } else if (input === 'c' && onOpenConfig) {
      onOpenConfig();
    } else if (input === 'q' || key.escape) {
      // Engine is drained by the unmount cleanup effect.
      onBack ? onBack() : exit();
    }
  });

  // -------------------------------------------------------------------------
  // Derived render values
  // -------------------------------------------------------------------------
  const active = Object.values(activeJobs);
  const inFlight = active.length;
  const now = Date.now();

  // Connection status label + color
  let connLabel: string;
  let connColor: string;
  if (engineState === 'stopped') {
    connLabel = 'stopped';
    connColor = 'gray';
  } else if (engineState === 'starting') {
    connLabel = 'starting…';
    connColor = 'yellow';
  } else if (heartbeat.ok) {
    connLabel = engineState === 'draining' ? 'draining' : 'online';
    connColor = engineState === 'draining' ? 'yellow' : 'green';
  } else {
    connLabel = 'no heartbeat';
    connColor = 'red';
  }

  const hbLabel = heartbeat.at
    ? `${hhmmss(new Date(heartbeat.at))}${heartbeat.ok ? '' : ' (failing)'}`
    : 'never';

  // -------------------------------------------------------------------------
  // Doctor overlay render
  // -------------------------------------------------------------------------
  if (showDoctor) {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Capability Doctor</Text>
        {doctorLoading && (
          <Box marginTop={1}>
            <Text color="cyan"><Spinner type="dots" /> probing capabilities…</Text>
          </Box>
        )}
        {!doctorLoading && doctorReport && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text bold dimColor>{'Capability'.padEnd(14)}</Text>
              <Text bold dimColor>{'Status'.padEnd(8)}</Text>
              <Text bold dimColor>Detail</Text>
            </Box>
            {Object.entries(doctorReport).map(([key, status]) => (
              <Box key={key} flexDirection="row">
                <Text>{key.padEnd(14)}</Text>
                <Text color={status.available ? 'green' : 'red'}>
                  {(status.available ? 'yes' : 'no').padEnd(8)}
                </Text>
                <Text dimColor>{truncate(status.detail ?? '', 44)}</Text>
              </Box>
            ))}
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
        </Box>
        <Box flexDirection="row">
          <Text dimColor>heartbeat: </Text>
          <Text color={heartbeat.ok ? 'green' : engineState === 'stopped' ? 'gray' : 'red'}>{hbLabel}</Text>
          <Text dimColor>   concurrency: {options.concurrency}</Text>
          <Text dimColor>   poll: {options.pollIntervalMs}ms</Text>
        </Box>
        <Box flexDirection="row">
          <Text dimColor>types: {truncate(options.eligibleTypes.join(', '), 72)}</Text>
        </Box>
      </Box>

      {!registered && (
        <Box paddingX={2}>
          <Text color="yellow">
            ⚠ This machine is not registered. Run `memoriahub node register` before starting.
          </Text>
        </Box>
      )}

      {/* Counters band */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="row" paddingX={2} paddingY={0} gap={3}>
        <Text>In-flight: <Text color="cyan">{inFlight}</Text></Text>
        <Text>Succeeded: <Text color="green">{succeeded}</Text></Text>
        <Text>Failed: <Text color={failed > 0 ? 'red' : 'white'}>{failed}</Text></Text>
        <Text>Throughput: <Text color="cyan">{jobsPerMin}</Text><Text dimColor>/min</Text></Text>
      </Box>

      {/* Per-slot rows */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Slots</Text>
        {Array.from({ length: options.concurrency }, (_, i) => {
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
          const label =
            engineState === 'running' ? (idle ? 'idle — waiting for work' : 'waiting for work') : 'idle';
          return (
            <Box key={`slot-${i}`} flexDirection="row" gap={1}>
              <Text dimColor>{String(i + 1).padStart(2)}.</Text>
              <Text dimColor>{label}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Model status */}
      <Box paddingX={2}>
        <Text dimColor>models: </Text>
        <Text dimColor>{modelStatus ?? '(not loaded — press s to start)'}</Text>
      </Box>

      {/* Error / heartbeat log */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Log (errors / heartbeat)</Text>
        {log.length === 0 && <Text dimColor>No errors.</Text>}
        {log.map((e) => (
          <Box key={e.id} flexDirection="row" gap={1}>
            <Text dimColor>{hhmmss(e.ts)}</Text>
            <Text color={e.level === 'error' ? 'red' : 'yellow'}>{e.level === 'error' ? '✖' : '⚠'}</Text>
            <Text color={e.level === 'error' ? 'red' : 'yellow'}>{truncate(e.msg, 70)}</Text>
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box paddingX={2}>
        <Text dimColor>
          [s] start   [d] drain/stop   [r] doctor{onOpenConfig ? '   [c] config' : ''}   [q] back
        </Text>
      </Box>

    </Box>
  );
}
