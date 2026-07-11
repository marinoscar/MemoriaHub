/**
 * tui/node-dashboard-source.ts — shared state model + data sources for the
 * worker-node TUI dashboard (NodeDashboard.tsx).
 *
 * The dashboard can render from two different places:
 *   - ATTACHED: a `memoriahub node start --daemon` process is already running;
 *     we connect to its NDJSON IPC socket (node/ipc-client.ts), hydrate from
 *     the `snapshot` greeting frame, and translate live `{kind:'event'}`
 *     frames into state updates.
 *   - EMBEDDED: no daemon is running; the dashboard owns an in-process
 *     NodeEngine (current historical behavior) and consumes its typed events
 *     directly.
 *
 * Both feed the SAME pure reducer (reduceNodeEvent) over one DashboardState,
 * so the React component has exactly one update path regardless of where the
 * events come from. The reducer is a plain function (state, ev, payload, now)
 * → state, which keeps it unit-testable without Ink or sockets.
 */

import {
  connectToDaemon,
  type DaemonClient,
  type DaemonMessage,
} from '../node/ipc-client.js';
import { NODE_EV } from '../node/node-events.js';
import type { NodeEngine } from '../node/node-engine.js';

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

function makeLogEntry(level: DashLogLevel, msg: string, atMs: number): DashLogEntry {
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
// DashboardSource — one interface, two implementations
// ---------------------------------------------------------------------------

export type DashboardSourceMode = 'attached' | 'embedded';

export interface DashboardSource {
  readonly mode: DashboardSourceMode;
  /** Attached: the greeting snapshot. Embedded: null (state starts empty). */
  readonly snapshot: DaemonSnapshot | null;
  /** Attached: recent daemon log lines from the greeting. Embedded: empty. */
  readonly logTail: string[];
  /** Subscribe to engine events. Events buffered before subscribe are flushed. */
  onEvent(cb: (ev: string, payload: unknown) => void): void;
  /** Subscribe to source loss (attached: socket close). Embedded: never fires. */
  onDisconnect(cb: () => void): void;
  setConcurrency(n: number): void;
  /** Stop claiming, finish in-flight work (daemon/engine keeps running). */
  drain(): void;
  /** Fully stop: attached sends {cmd:'stop'} (daemon exits); embedded stops the engine. */
  stop(): void;
  /**
   * Detach the dashboard. Attached: ONLY closes the socket — the daemon keeps
   * running. Embedded: stops the in-process engine (nothing must outlive the UI).
   */
  close(): void;
}

// ---- Attached --------------------------------------------------------------

class AttachedDashboardSource implements DashboardSource {
  readonly mode = 'attached' as const;
  readonly snapshot: DaemonSnapshot;
  readonly logTail: string[] = [];

  private eventCb: ((ev: string, payload: unknown) => void) | null = null;
  private readonly pendingEvents: Array<[string, unknown]> = [];

  constructor(
    private readonly client: DaemonClient,
    snapshot: DaemonSnapshot,
  ) {
    this.snapshot = snapshot;
  }

  /** @internal wired by createAttachedSource's onMessage handler. */
  _dispatch(msg: DaemonMessage): void {
    if (msg.kind === 'event') {
      const ev = typeof msg.ev === 'string' ? msg.ev : '';
      if (!ev) return;
      if (this.eventCb) this.eventCb(ev, msg.payload);
      else this.pendingEvents.push([ev, msg.payload]);
    } else if (msg.kind === 'log-tail' && Array.isArray(msg.lines)) {
      for (const line of msg.lines) {
        if (typeof line === 'string') this.logTail.push(line);
      }
    }
  }

  onEvent(cb: (ev: string, payload: unknown) => void): void {
    this.eventCb = cb;
    while (this.pendingEvents.length > 0) {
      const [ev, payload] = this.pendingEvents.shift()!;
      cb(ev, payload);
    }
  }

  onDisconnect(cb: () => void): void {
    this.client.onClose(cb);
  }

  setConcurrency(n: number): void {
    this.client.send({ cmd: 'set-concurrency', value: n });
  }

  drain(): void {
    this.client.send({ cmd: 'drain' });
  }

  stop(): void {
    this.client.send({ cmd: 'stop' });
  }

  close(): void {
    // Never stops the daemon — just detaches this dashboard.
    this.client.close();
  }
}

/**
 * Connect to a running daemon and build an attached source. Resolves once the
 * greeting `snapshot` frame has arrived (and, best-effort, the `log-tail`
 * frame the daemon sends immediately after it). Rejects when nothing is
 * listening on the socket.
 */
export async function createAttachedSource(
  socketPath?: string,
  timeoutMs?: number,
): Promise<DashboardSource> {
  const client = await connectToDaemon(socketPath, timeoutMs);
  try {
    let source: AttachedDashboardSource | null = null;
    const early: DaemonMessage[] = [];
    client.onMessage((msg) => {
      if (source) source._dispatch(msg);
      else early.push(msg);
    });

    const snapMsg = await client.waitFor((m) => m.kind === 'snapshot', 5000);
    const snapshot = parseSnapshotFrame(snapMsg);
    source = new AttachedDashboardSource(client, snapshot);
    for (const msg of early) source._dispatch(msg);
    // The daemon writes log-tail right after the snapshot; wait briefly so
    // source.logTail is populated before the dashboard hydrates. Best-effort.
    if (source.logTail.length === 0) {
      await client.waitFor((m) => m.kind === 'log-tail', 1000).catch(() => undefined);
    }
    return source;
  } catch (err) {
    client.close();
    throw err;
  }
}

// ---- Embedded ---------------------------------------------------------------

/**
 * Embedded source: wraps an in-process NodeEngine the dashboard constructs
 * lazily (on `s`). Events from the engine are forwarded through the same
 * onEvent callback the attached source uses, so the component's reducer path
 * is identical in both modes.
 */
export class EmbeddedDashboardSource implements DashboardSource {
  readonly mode = 'embedded' as const;
  readonly snapshot: DaemonSnapshot | null = null;
  readonly logTail: string[] = [];

  private engine: NodeEngine | null = null;
  private eventCb: ((ev: string, payload: unknown) => void) | null = null;
  private readonly pendingEvents: Array<[string, unknown]> = [];
  private closed = false;

  /** Whether an engine is currently attached (created and not yet stopped). */
  get hasEngine(): boolean {
    return this.engine !== null;
  }

  /** Attach a freshly-constructed engine and subscribe to all its events. */
  attachEngine(engine: NodeEngine): void {
    this.engine = engine;
    const emitter = engine as unknown as {
      on(event: string, listener: (payload: unknown) => void): void;
    };
    for (const ev of Object.values(NODE_EV)) {
      emitter.on(ev, (payload: unknown) => this.emit(ev, payload));
    }
  }

  /** Drop the engine reference after it has stopped. */
  releaseEngine(): void {
    if (this.engine) {
      this.engine.removeAllListeners();
      this.engine = null;
    }
  }

  private emit(ev: string, payload: unknown): void {
    if (this.closed) return;
    if (this.eventCb) this.eventCb(ev, payload);
    else this.pendingEvents.push([ev, payload]);
  }

  onEvent(cb: (ev: string, payload: unknown) => void): void {
    this.eventCb = cb;
    while (this.pendingEvents.length > 0) {
      const [ev, payload] = this.pendingEvents.shift()!;
      cb(ev, payload);
    }
  }

  onDisconnect(_cb: () => void): void {
    // An in-process engine cannot "disconnect"; STOPPED events cover shutdown.
  }

  setConcurrency(n: number): void {
    this.engine?.setConcurrency(n);
  }

  drain(): void {
    this.engine?.drain();
  }

  stop(): void {
    // Preserves the dashboard's historical `d` behavior: a full stop.
    void this.engine?.stop('drain');
  }

  close(): void {
    this.closed = true;
    const e = this.engine;
    if (e) {
      e.removeAllListeners();
      void e.stop('unmount');
      this.engine = null;
    }
  }
}
