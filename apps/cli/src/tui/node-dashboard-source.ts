/**
 * tui/node-dashboard-source.ts — the worker-node dashboard as a platform
 * dashboard (RETRO-F4, #582): the shared state model, a pure reducer and the two
 * feeds NodeDashboard.tsx follows.
 *
 * The dashboard can render from two different places, now two `DashboardFeed`s
 * behind one `DashboardSource` (`@marinoscar/platform-cli/tui`):
 *   - ATTACHED: a `memoriahub node start --daemon` process is already running;
 *     the platform's `daemonAttachFeed` connects to its NDJSON IPC socket through
 *     the 1.3 protocol adapter (legacy-daemon.ts), hydrates from the `snapshot`
 *     greeting, appends the log tail and applies live event frames. It
 *     reconnects by itself when the daemon restarts (the memory valve restarts a
 *     worker). Detaching only closes the socket: the daemon keeps running.
 *   - EMBEDDED: no daemon is running; the dashboard owns an in-process
 *     NodeEngine and `embeddedNodeFeed` follows its typed events.
 *
 * Both feed the SAME pure reducer (`nodeDashboardReducer`, over reduceNodeEvent)
 * over one DashboardState, so the React component has exactly one update path
 * regardless of where the events come from. The reducer is a plain function, which
 * keeps it unit-testable without Ink or sockets.
 *
 * Commands (drain, stop) are not part of an attach feed: `daemonControl` sends them
 * over a short-lived second connection, `engineControl` calls the in-process engine.
 */

import {
  DashboardSource,
  daemonAttachFeed,
  type DashboardFeed,
  type DashboardReducer,
} from '@marinoscar/platform-cli/tui';

import { nodeSocketPath } from '../paths.js';
import { NODE_EV } from '../node/node-events.js';
import type { NodeEngine } from '../node/node-engine.js';
import { legacyDaemonConnect, parseLegacyEvent, sendDaemonCommand } from './legacy-daemon.js';

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

/** Log pane cap (mirrors the dashboard's historical MAX_LOG). */
export const MAX_LOG = 15;
/** Completed-job history cap kept client-side (mirrors the engine's ring). */
export const MAX_HISTORY = 50;

export interface DashActiveJob {
  jobId: string;
  type: string;
  mediaItemId: string | null;
  /** Wall-clock ms when the job started (for elapsed rendering). */
  startMs: number;
  /** 0–1 progress fraction; 0 when unknown. */
  fraction: number;
}

export interface DashHistoryEntry {
  jobId: string;
  type: string;
  status: 'done' | 'error';
  durationMs?: number;
  error?: string;
  finishedAt: string;
}

export type DashLogLevel = 'error' | 'warn' | 'info';

export interface DashLogEntry {
  id: number;
  ts: Date;
  level: DashLogLevel;
  msg: string;
}

export interface DashboardState {
  activeJobs: Record<string, DashActiveJob>;
  /** Last MAX_HISTORY completed/failed jobs, oldest first. */
  history: DashHistoryEntry[];
  counters: { succeeded: number; failed: number; claimed: number };
  heartbeat: { ok: boolean; at: string | null };
  concurrency: number;
  eligibleTypes: string[] | null;
  draining: boolean;
  /** ISO timestamp the engine started (uptime anchor); null when unknown. */
  startedAt: string | null;
  idle: boolean;
  /** Set when a `stopped` event is observed. */
  stopped: boolean;
  modelStatus: string | null;
  log: DashLogEntry[];
  /** Wall-clock ms timestamps of recent completions (throughput basis). */
  completions: number[];
}

/** Snapshot shape served by the daemon greeting / `{cmd:'status'}` reply. */
export interface DaemonSnapshot {
  nodeId: string | null;
  startedAt: string | null;
  concurrency: number;
  eligibleTypes: string[];
  activeJobs: Array<{ jobId: string; type: string; startedAt: string }>;
  history: DashHistoryEntry[];
  counters: { succeeded: number; failed: number; claimed: number };
  lastHeartbeatAt: string | null;
  draining: boolean;
}

// ---------------------------------------------------------------------------
// State constructors / helpers (pure)
// ---------------------------------------------------------------------------

let logSeq = 0;

/** A log line stamped with the next sequence id (ids order lines from several writers). */
export function makeLogEntry(level: DashLogLevel, msg: string, atMs: number): DashLogEntry {
  return { id: ++logSeq, ts: new Date(atMs), level, msg };
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function initialDashboardState(concurrency: number, eligibleTypes?: string[]): DashboardState {
  return {
    activeJobs: {},
    history: [],
    counters: { succeeded: 0, failed: 0, claimed: 0 },
    heartbeat: { ok: false, at: null },
    concurrency: Math.max(1, concurrency),
    eligibleTypes: eligibleTypes ?? null,
    draining: false,
    startedAt: null,
    idle: false,
    stopped: false,
    modelStatus: null,
    log: [],
    completions: [],
  };
}

/** Append log lines (pure); trims to MAX_LOG. */
export function appendLogLines(
  state: DashboardState,
  entries: Array<{ level: DashLogLevel; msg: string }>,
  nowMs: number = Date.now(),
): DashboardState {
  if (entries.length === 0) return state;
  const log = [...state.log, ...entries.map((e) => makeLogEntry(e.level, e.msg, nowMs))].slice(-MAX_LOG);
  return { ...state, log };
}

/** Defensively parse a daemon `snapshot`/`status` frame into a DaemonSnapshot. */
export function parseSnapshotFrame(msg: Record<string, unknown>): DaemonSnapshot {
  const counters = (msg.counters ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const activeJobs = Array.isArray(msg.activeJobs) ? msg.activeJobs : [];
  const history = Array.isArray(msg.history) ? msg.history : [];
  return {
    nodeId: str(msg.nodeId),
    startedAt: str(msg.startedAt),
    concurrency: Math.max(1, num(msg.concurrency) || 1),
    eligibleTypes: Array.isArray(msg.eligibleTypes)
      ? msg.eligibleTypes.filter((t): t is string => typeof t === 'string')
      : [],
    activeJobs: activeJobs
      .filter((j): j is Record<string, unknown> => j !== null && typeof j === 'object')
      .map((j) => ({
        jobId: String(j.jobId ?? ''),
        type: String(j.type ?? 'unknown'),
        startedAt: str(j.startedAt) ?? new Date().toISOString(),
      })),
    history: history
      .filter((h): h is Record<string, unknown> => h !== null && typeof h === 'object')
      .map((h) => ({
        jobId: String(h.jobId ?? ''),
        type: String(h.type ?? 'unknown'),
        status: h.status === 'error' ? ('error' as const) : ('done' as const),
        durationMs: typeof h.durationMs === 'number' ? h.durationMs : undefined,
        error: typeof h.error === 'string' ? h.error : undefined,
        finishedAt: str(h.finishedAt) ?? new Date().toISOString(),
      })),
    counters: {
      succeeded: num(counters.succeeded),
      failed: num(counters.failed),
      claimed: num(counters.claimed),
    },
    lastHeartbeatAt: str(msg.lastHeartbeatAt),
    draining: msg.draining === true,
  };
}

/**
 * Hydrate dashboard state from a daemon snapshot (attached-mode initial
 * state). Counters/history/active jobs replace whatever was there; the log
 * pane is preserved (log-tail lines are appended separately).
 */
export function hydrateFromSnapshot(state: DashboardState, snap: DaemonSnapshot): DashboardState {
  const activeJobs: Record<string, DashActiveJob> = {};
  for (const j of snap.activeJobs) {
    const parsed = Date.parse(j.startedAt);
    activeJobs[j.jobId] = {
      jobId: j.jobId,
      type: j.type,
      mediaItemId: null,
      startMs: Number.isFinite(parsed) ? parsed : Date.now(),
      fraction: 0,
    };
  }
  return {
    ...state,
    activeJobs,
    history: snap.history.slice(-MAX_HISTORY),
    counters: { ...snap.counters },
    heartbeat: { ok: snap.lastHeartbeatAt !== null, at: snap.lastHeartbeatAt },
    concurrency: snap.concurrency,
    eligibleTypes: snap.eligibleTypes.length > 0 ? snap.eligibleTypes : state.eligibleTypes,
    draining: snap.draining,
    startedAt: snap.startedAt,
    stopped: false,
  };
}

// ---------------------------------------------------------------------------
// Event reducer (pure) — the single update path shared by both modes
// ---------------------------------------------------------------------------

/**
 * Apply one engine event (embedded: from engine.on(...); attached: from a
 * `{kind:'event', ev, payload}` frame) to the dashboard state. Mirrors the
 * per-event handler bodies the dashboard historically kept inline.
 */
export function reduceNodeEvent(
  state: DashboardState,
  ev: string,
  payload: unknown,
  nowMs: number = Date.now(),
): DashboardState {
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (ev) {
    case NODE_EV.CLAIMED: {
      const count = typeof p.count === 'number' ? p.count : 0;
      return {
        ...state,
        idle: false,
        counters: { ...state.counters, claimed: state.counters.claimed + count },
      };
    }

    case NODE_EV.JOB_START: {
      const jobId = String(p.jobId ?? '');
      if (!jobId) return state;
      return {
        ...state,
        idle: false,
        activeJobs: {
          ...state.activeJobs,
          [jobId]: {
            jobId,
            type: String(p.type ?? 'unknown'),
            mediaItemId: typeof p.mediaItemId === 'string' ? p.mediaItemId : null,
            startMs: nowMs,
            fraction: 0,
          },
        },
      };
    }

    case NODE_EV.JOB_PROGRESS: {
      const jobId = String(p.jobId ?? '');
      const job = state.activeJobs[jobId];
      if (!job) return state;
      const fraction = typeof p.fraction === 'number' ? p.fraction : job.fraction;
      return { ...state, activeJobs: { ...state.activeJobs, [jobId]: { ...job, fraction } } };
    }

    case NODE_EV.JOB_DONE: {
      const jobId = String(p.jobId ?? '');
      const type = String(p.type ?? 'unknown');
      const activeJobs = { ...state.activeJobs };
      delete activeJobs[jobId];
      const entry: DashHistoryEntry = {
        jobId,
        type,
        status: 'done',
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
        finishedAt: new Date(nowMs).toISOString(),
      };
      let next: DashboardState = {
        ...state,
        activeJobs,
        counters: { ...state.counters, succeeded: state.counters.succeeded + 1 },
        history: [...state.history, entry].slice(-MAX_HISTORY),
        completions: [...state.completions.filter((t) => nowMs - t <= 60_000), nowMs],
      };
      if (p.submitted === false) {
        next = appendLogLines(
          next,
          [{ level: 'warn', msg: `job ${shortId(jobId)} (${type}) computed but result endpoint unavailable` }],
          nowMs,
        );
      }
      return next;
    }

    case NODE_EV.JOB_ERROR: {
      const jobId = String(p.jobId ?? '');
      const type = String(p.type ?? 'unknown');
      const error = typeof p.error === 'string' ? p.error : 'unknown error';
      const activeJobs = { ...state.activeJobs };
      delete activeJobs[jobId];
      const entry: DashHistoryEntry = {
        jobId,
        type,
        status: 'error',
        error,
        finishedAt: new Date(nowMs).toISOString(),
      };
      const next: DashboardState = {
        ...state,
        activeJobs,
        counters: { ...state.counters, failed: state.counters.failed + 1 },
        history: [...state.history, entry].slice(-MAX_HISTORY),
        completions: [...state.completions.filter((t) => nowMs - t <= 60_000), nowMs],
      };
      return appendLogLines(
        next,
        [{ level: 'error', msg: `job ${shortId(jobId)} (${type}) failed: ${error}` }],
        nowMs,
      );
    }

    case NODE_EV.IDLE:
      return { ...state, idle: true };

    case NODE_EV.HEARTBEAT_OK: {
      const at = typeof p.at === 'string' ? p.at : new Date(nowMs).toISOString();
      return { ...state, heartbeat: { ok: true, at } };
    }

    case NODE_EV.HEARTBEAT_FAIL: {
      const error = typeof p.error === 'string' ? p.error : 'unknown error';
      return appendLogLines(
        { ...state, heartbeat: { ok: false, at: state.heartbeat.at } },
        [{ level: 'error', msg: `heartbeat: ${error}` }],
        nowMs,
      );
    }

    case NODE_EV.MODEL_LOADED: {
      const failed = typeof p.failed === 'number' ? p.failed : 0;
      return {
        ...state,
        modelStatus:
          `Models loaded from ${String(p.targetDir ?? '?')} (${String(p.downloaded ?? 0)} downloaded, ` +
          `${String(p.present ?? 0)} present${failed > 0 ? `, ${failed} failed` : ''})`,
      };
    }

    case NODE_EV.STOPPED:
      return { ...state, stopped: true, idle: false, draining: false, activeJobs: {} };

    default:
      // LEASE_RENEW and unknown/newer event kinds: no visible state change.
      return state;
  }
}

// ---------------------------------------------------------------------------
// Platform dashboard pieces: reducer, feeds, controls
// ---------------------------------------------------------------------------

/** One engine event as the reducer folds it; `atMs` is when the dashboard saw it. */
export interface NodeDashEvent {
  ev: string;
  payload: unknown;
  atMs: number;
}

export type NodeDashboardSource = DashboardSource<DashboardState, NodeDashEvent>;

/**
 * The pure reducer behind the dashboard: `initial` is the empty state for the configured
 * concurrency and types, `hydrate` takes the daemon's snapshot, `reduce` is {@link reduceNodeEvent},
 * `log` appends the daemon's log tail (as the 1.3 dashboard did, at `info`).
 */
export function nodeDashboardReducer(
  concurrency: number,
  eligibleTypes?: string[],
): DashboardReducer<DashboardState, NodeDashEvent> {
  return {
    initial: () => initialDashboardState(concurrency, eligibleTypes),
    hydrate: (state, snapshot) =>
      hydrateFromSnapshot(state, parseSnapshotFrame((snapshot ?? {}) as Record<string, unknown>)),
    reduce: (state, event) => reduceNodeEvent(state, event.ev, event.payload, event.atMs),
    log: (state, lines) => appendLogLines(state, lines.map((l) => ({ level: 'info' as const, msg: l.msg }))),
    parseEvent: (frame) => {
      const parsed = parseLegacyEvent(frame);
      return parsed ? { ev: parsed.ev, payload: parsed.payload, atMs: Date.now() } : undefined;
    },
  };
}

/** Attach (read-only, reconnecting) to the worker daemon's socket. */
export function nodeDaemonFeed(socketPath: string = nodeSocketPath()): DashboardFeed<NodeDashEvent> {
  return daemonAttachFeed<NodeDashEvent>({ socketPath, connect: legacyDaemonConnect('node') as never });
}

/**
 * Follow an in-process engine's typed events. `onEvent` runs after the dashboard state has the
 * event (the component uses it to forget a stopped engine). Stopping the feed only detaches the
 * listeners; stopping the engine is the component's job on unmount.
 */
export function embeddedNodeFeed(
  engine: NodeEngine,
  hooks: { onEvent?: (event: NodeDashEvent) => void } = {},
): DashboardFeed<NodeDashEvent> {
  const emitter = engine as unknown as {
    on(event: string, listener: (payload: unknown) => void): void;
    removeAllListeners(): void;
  };
  let stopped = false;
  return {
    mode: 'embedded',
    async start(emit) {
      emit({ kind: 'attempt' });
      emit({ kind: 'connected' });
      for (const ev of Object.values(NODE_EV)) {
        emitter.on(ev, (payload: unknown) => {
          if (stopped) return;
          const event: NodeDashEvent = { ev, payload, atMs: Date.now() };
          emit({ kind: 'event', event });
          hooks.onEvent?.(event);
        });
      }
    },
    stop() {
      stopped = true;
      emitter.removeAllListeners();
    },
  };
}

/** A dashboard source over `feed`, starting from the persisted node config. */
export function createNodeSource(
  feed: DashboardFeed<NodeDashEvent>,
  concurrency: number,
  eligibleTypes?: string[],
): NodeDashboardSource {
  return new DashboardSource(nodeDashboardReducer(concurrency, eligibleTypes), feed);
}

/** What the dashboard can ask of whatever is doing the work. */
export interface NodeControl {
  /** Stop claiming, finish in-flight work (the daemon or engine keeps running). */
  drain(): void;
  /** Fully stop: the daemon exits / the engine stops. */
  stop(): void;
  setConcurrency(n: number): void;
}

/** Controls for a daemon: each command goes over its own short-lived connection. */
export function daemonControl(socketPath: string = nodeSocketPath()): NodeControl {
  const send = (command: Record<string, unknown>): void => {
    void sendDaemonCommand(command, { socketPath }).catch(() => undefined);
  };
  return {
    drain: () => send({ cmd: 'drain' }),
    stop: () => send({ cmd: 'stop' }),
    setConcurrency: (value) => send({ cmd: 'set-concurrency', value }),
  };
}

/** Controls for an in-process engine. */
export function engineControl(engine: NodeEngine): NodeControl {
  return {
    drain: () => engine.drain(),
    // Preserves the dashboard's historical `d` behavior: a full stop.
    stop: () => void engine.stop('drain'),
    setConcurrency: (n) => engine.setConcurrency(n),
  };
}
