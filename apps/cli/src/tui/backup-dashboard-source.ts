/**
 * tui/backup-dashboard-source.ts — shared state model + data sources for the
 * backup TUI dashboard (BackupDashboard.tsx).
 *
 * Deliberately the SAME shape as tui/node-dashboard-source.ts, because the two
 * dashboards have the same problem: the work can be happening in a detached
 * daemon or in this process, and the view must not care which.
 *
 *   - ATTACHED: a `memoriahub node start --daemon` process is running with a
 *     bound backup root. We connect to its NDJSON IPC socket
 *     (node/ipc-client.ts), hydrate from a `backup-status` reply, and translate
 *     live `{kind:'backup-event', ev, payload}` frames into state updates.
 *     Closing DETACHES — it never stops the daemon or its backup run.
 *   - EMBEDDED: no daemon is running; the dashboard owns an in-process
 *     BackupEngine and consumes its typed events directly.
 *
 * Both feed the SAME pure reducer (reduceBackupEvent) over one
 * BackupDashboardState, so the React component has exactly one update path.
 * The reducer and the snapshot parser are plain functions — unit-testable
 * without Ink or sockets.
 */

import { connectToDaemon, type DaemonClient, type DaemonMessage } from '../node/ipc-client.js';
import { BACKUP_EV } from '../backup/events.js';
import type { BackupTypedEmitter } from '../backup/events.js';

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

/** Event-log pane cap (mirrors the node dashboard's MAX_LOG). */
export const MAX_LOG = 15;
/** Recent-run rows kept client-side. */
export const MAX_RUNS = 10;

export type BackupRunState = 'idle' | 'running' | 'cancelling';

export type BackupLogLevel = 'error' | 'warn' | 'info';

export interface BackupLogEntry {
  id: number;
  ts: Date;
  level: BackupLogLevel;
  msg: string;
}

export interface BackupRunRow {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  itemsDownloaded?: number;
  errorCount?: number;
}

export interface BackupCounters {
  totalItems: number;
  totalBytes: number;
  present: number;
  failed: number;
  quarantined: number;
  trashed: number;
}

export interface BackupProgress {
  /** Items whose processing finished in the ACTIVE run. */
  items: number;
  downloaded: number;
  skipped: number;
  errors: number;
  bytes: number;
  /** Wall-clock ms the active run started (rate basis); null when idle. */
  startMs: number | null;
}

export interface BackupDashboardState {
  runState: BackupRunState;
  /** Trigger of the active run; null when idle. */
  trigger: string | null;
  /** Kind of the active run ('incremental' | 'reconcile'); null when idle. */
  kind: string | null;
  runId: string | null;
  progress: BackupProgress;
  /** Mirrored checkpoint cursor from the last status snapshot. */
  checkpoint: { updatedAt: string; id: string } | null;
  /** Server-reported change-feed lag past the checkpoint. */
  pending: { items: number; bytes: number } | null;
  counters: BackupCounters | null;
  runs: BackupRunRow[];
  rate: { concurrency: number; maxMbps: number } | null;
  /** Last reconcile-done payload, surfaced under the progress block. */
  reconcile: { manifestIds: number; quarantined: number; driftMarked: number } | null;
  log: BackupLogEntry[];
}

/** Snapshot shape served by the daemon's `backup-status` reply. */
export interface BackupSnapshot {
  configured: boolean;
  running: { trigger: string; startedAt: string } | null;
  lastRun: BackupRunRow | null;
  checkpoint: { updatedAt: string; id: string } | null;
  counters: BackupCounters | null;
  rate: { concurrency: number; maxMbps: number } | null;
}

// ---------------------------------------------------------------------------
// Constructors / helpers (pure)
// ---------------------------------------------------------------------------

let logSeq = 0;

function makeLogEntry(level: BackupLogLevel, msg: string, atMs: number): BackupLogEntry {
  return { id: ++logSeq, ts: new Date(atMs), level, msg };
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function emptyProgress(): BackupProgress {
  return { items: 0, downloaded: 0, skipped: 0, errors: 0, bytes: 0, startMs: null };
}

export function initialBackupDashboardState(): BackupDashboardState {
  return {
    runState: 'idle',
    trigger: null,
    kind: null,
    runId: null,
    progress: emptyProgress(),
    checkpoint: null,
    pending: null,
    counters: null,
    runs: [],
    rate: null,
    reconcile: null,
    log: [],
  };
}

/** Append log lines (pure); trims to MAX_LOG. */
export function appendBackupLog(
  state: BackupDashboardState,
  entries: Array<{ level: BackupLogLevel; msg: string }>,
  nowMs: number = Date.now(),
): BackupDashboardState {
  if (entries.length === 0) return state;
  const log = [...state.log, ...entries.map((e) => makeLogEntry(e.level, e.msg, nowMs))].slice(
    -MAX_LOG,
  );
  return { ...state, log };
}

/** Current download rate (bytes/sec) of the active run; 0 when idle/unstarted. */
export function currentBytesPerSec(state: BackupDashboardState, nowMs: number = Date.now()): number {
  const { startMs, bytes } = state.progress;
  if (startMs === null || bytes === 0) return 0;
  const elapsedSec = Math.max(0.001, (nowMs - startMs) / 1000);
  return bytes / elapsedSec;
}

/** Age of the mirrored checkpoint in ms, or null when there is none. */
export function checkpointAgeMs(
  state: BackupDashboardState,
  nowMs: number = Date.now(),
): number | null {
  if (!state.checkpoint) return null;
  const t = Date.parse(state.checkpoint.updatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

// ---------------------------------------------------------------------------
// Snapshot parsing / hydration (pure)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseCounters(raw: unknown): BackupCounters | null {
  if (raw === null || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const byStatus = (c.byStatus ?? {}) as Record<string, { count?: unknown } | undefined>;
  const count = (key: string): number => num(byStatus[key]?.count);
  return {
    totalItems: num(c.totalItems),
    totalBytes: num(c.totalBytes),
    present: count('present'),
    failed: count('failed'),
    quarantined: count('quarantined'),
    trashed: count('trashed'),
  };
}

function parseRunRow(raw: unknown): BackupRunRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    kind: str(r.kind) ?? 'incremental',
    status: str(r.status) ?? 'unknown',
    startedAt: str(r.startedAt) ?? '',
    finishedAt: str(r.finishedAt),
    itemsDownloaded: num(r.itemsDownloaded),
    errorCount: num(r.errorCount),
  };
}

/** Defensively parse a daemon `backup-status` frame into a BackupSnapshot. */
export function parseBackupSnapshot(msg: Record<string, unknown>): BackupSnapshot {
  const running =
    msg.running !== null && typeof msg.running === 'object'
      ? (msg.running as Record<string, unknown>)
      : null;
  const checkpoint =
    msg.checkpoint !== null && typeof msg.checkpoint === 'object'
      ? (msg.checkpoint as Record<string, unknown>)
      : null;
  const rate =
    msg.rate !== null && typeof msg.rate === 'object'
      ? (msg.rate as Record<string, unknown>)
      : null;

  const cpUpdatedAt = checkpoint ? str(checkpoint.updatedAt) : null;
  const cpId = checkpoint ? str(checkpoint.id) : null;

  return {
    configured: msg.configured !== false,
    running: running
      ? {
          trigger: str(running.trigger) ?? 'manual',
          startedAt: str(running.startedAt) ?? new Date().toISOString(),
        }
      : null,
    lastRun: parseRunRow(msg.lastRun),
    checkpoint: cpUpdatedAt !== null && cpId !== null ? { updatedAt: cpUpdatedAt, id: cpId } : null,
    counters: parseCounters(msg.counters),
    rate: rate ? { concurrency: num(rate.concurrency) || 1, maxMbps: num(rate.maxMbps) } : null,
  };
}

/**
 * Hydrate dashboard state from a status snapshot. Counters/checkpoint/rate and
 * the run list are replaced; the log pane and any in-flight progress are
 * preserved (a snapshot poll must not wipe the live progress the event stream
 * is building).
 */
export function hydrateFromBackupSnapshot(
  state: BackupDashboardState,
  snap: BackupSnapshot,
  nowMs: number = Date.now(),
): BackupDashboardState {
  const runs = snap.lastRun
    ? [snap.lastRun, ...state.runs.filter((r) => r.id !== snap.lastRun!.id)].slice(0, MAX_RUNS)
    : state.runs;

  // A snapshot showing a run the event stream has not announced (e.g. a
  // scheduled run started before we attached) still puts the view in
  // 'running'; a snapshot showing none never CANCELS a locally-known run
  // mid-cancel, which the run-finished event resolves.
  let runState = state.runState;
  let progress = state.progress;
  let trigger = state.trigger;
  if (snap.running && runState === 'idle') {
    runState = 'running';
    trigger = snap.running.trigger;
    const started = Date.parse(snap.running.startedAt);
    progress = { ...emptyProgress(), startMs: Number.isFinite(started) ? started : nowMs };
  }

  return {
    ...state,
    runState,
    trigger,
    progress,
    checkpoint: snap.checkpoint,
    counters: snap.counters ?? state.counters,
    rate: snap.rate ?? state.rate,
    runs,
  };
}

/** Merge server-reported pending lag (from GET /backup/config) into the view. */
export function applyPendingLag(
  state: BackupDashboardState,
  pending: { items: number; bytes: string | number } | null,
): BackupDashboardState {
  if (!pending) return { ...state, pending: null };
  return {
    ...state,
    pending: { items: num(pending.items), bytes: Number(pending.bytes) || 0 },
  };
}

// ---------------------------------------------------------------------------
// Event reducer (pure) — the single update path shared by both modes
// ---------------------------------------------------------------------------

/**
 * Apply one BackupEngine event (embedded: engine.on(...); attached: a
 * `{kind:'backup-event', ev, payload}` frame) to the dashboard state.
 */
export function reduceBackupEvent(
  state: BackupDashboardState,
  ev: string,
  payload: unknown,
  nowMs: number = Date.now(),
): BackupDashboardState {
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (ev) {
    case BACKUP_EV.RUN_STARTED: {
      const runId = str(p.runId);
      const kind = str(p.kind) ?? 'incremental';
      const next: BackupDashboardState = {
        ...state,
        runState: 'running',
        runId,
        kind,
        trigger: str(p.trigger),
        progress: { ...emptyProgress(), startMs: nowMs },
        reconcile: null,
      };
      return appendBackupLog(
        next,
        [{ level: 'info', msg: `run ${runId ? shortId(runId) : '?'} started (${kind})` }],
        nowMs,
      );
    }

    case BACKUP_EV.PAGE_FETCHED: {
      const items = num(p.items);
      if (items === 0 && num(p.pageIndex) === 0) {
        return appendBackupLog(
          state,
          [{ level: 'info', msg: 'no changes since the last run — already up to date' }],
          nowMs,
        );
      }
      return state;
    }

    case BACKUP_EV.ITEM_DONE: {
      const outcome = str(p.outcome) ?? 'failed';
      const bytes = num(p.bytes);
      const progress: BackupProgress = {
        ...state.progress,
        items: state.progress.items + 1,
        downloaded: state.progress.downloaded + (outcome === 'downloaded' ? 1 : 0),
        skipped:
          state.progress.skipped + (outcome !== 'downloaded' && outcome !== 'failed' ? 1 : 0),
        errors: state.progress.errors + (outcome === 'failed' ? 1 : 0),
        bytes: state.progress.bytes + (outcome === 'downloaded' ? bytes : 0),
        startMs: state.progress.startMs ?? nowMs,
      };
      const next: BackupDashboardState = { ...state, progress };
      if (outcome === 'failed') {
        const id = str(p.id) ?? '?';
        const error = str(p.error) ?? 'unknown error';
        return appendBackupLog(next, [{ level: 'error', msg: `${shortId(id)}: ${error}` }], nowMs);
      }
      return next;
    }

    case BACKUP_EV.PAGE_COMMITTED: {
      const cursor =
        p.cursor !== null && typeof p.cursor === 'object'
          ? (p.cursor as Record<string, unknown>)
          : null;
      const updatedAt = cursor ? str(cursor.updatedAt) : null;
      const id = cursor ? str(cursor.id) : null;
      if (updatedAt === null || id === null) return state;
      return { ...state, checkpoint: { updatedAt, id } };
    }

    case BACKUP_EV.THROTTLE: {
      const secs = (num(p.delayMs) / 1000).toFixed(1);
      return appendBackupLog(
        state,
        [{ level: 'warn', msg: `rate limited — backing off for ${secs}s` }],
        nowMs,
      );
    }

    case BACKUP_EV.RECONCILE_STARTED:
      return appendBackupLog(
        state,
        [{ level: 'info', msg: 'reconciling against the server manifest…' }],
        nowMs,
      );

    case BACKUP_EV.RECONCILE_DONE: {
      const reconcile = {
        manifestIds: num(p.manifestIds),
        quarantined: num(p.quarantined),
        driftMarked: num(p.driftMarked),
      };
      const cancelled = p.cancelled === true;
      return appendBackupLog(
        { ...state, reconcile },
        [
          {
            level: cancelled ? 'warn' : 'info',
            msg: cancelled
              ? 'reconcile cancelled before the manifest completed — no diff applied'
              : `reconcile: ${reconcile.manifestIds} checked, ${reconcile.quarantined} quarantined, ` +
                `${reconcile.driftMarked} to re-download`,
          },
        ],
        nowMs,
      );
    }

    case BACKUP_EV.RUN_FINISHED: {
      const status = str(p.status) ?? 'completed';
      const stats = (p.stats ?? {}) as Record<string, unknown>;
      const row: BackupRunRow = {
        id: state.runId ?? `local-${nowMs}`,
        kind: state.kind ?? 'incremental',
        status,
        startedAt:
          state.progress.startMs !== null
            ? new Date(state.progress.startMs).toISOString()
            : new Date(nowMs).toISOString(),
        finishedAt: new Date(nowMs).toISOString(),
        itemsDownloaded: num(stats.itemsDownloaded),
        errorCount: num(stats.errors),
      };
      const next: BackupDashboardState = {
        ...state,
        runState: 'idle',
        runId: null,
        trigger: null,
        kind: null,
        runs: [row, ...state.runs.filter((r) => r.id !== row.id)].slice(0, MAX_RUNS),
      };
      const error = str(p.error);
      return appendBackupLog(
        next,
        [
          {
            level: status === 'completed' ? 'info' : status === 'aborted' ? 'warn' : 'error',
            msg:
              `run ${status}: ${num(stats.itemsDownloaded)} downloaded, ${num(stats.errors)} error(s)` +
              (error ? ` — ${error}` : ''),
          },
        ],
        nowMs,
      );
    }

    case BACKUP_EV.ERROR: {
      const message = str(p.message) ?? 'unknown error';
      return appendBackupLog(state, [{ level: 'error', msg: message }], nowMs);
    }

    default:
      return state;
  }
}

/** Local optimistic transition when the user presses [c]. */
export function markCancelling(state: BackupDashboardState): BackupDashboardState {
  if (state.runState !== 'running') return state;
  return { ...state, runState: 'cancelling' };
}

// ---------------------------------------------------------------------------
// BackupDashboardSource — one interface, two implementations
// ---------------------------------------------------------------------------

export type BackupSourceMode = 'attached' | 'embedded';

export interface BackupDashboardSource {
  readonly mode: BackupSourceMode;
  /** Attached: the initial backup-status reply. Embedded: null. */
  readonly snapshot: BackupSnapshot | null;
  /** Subscribe to engine events. Events buffered before subscribe are flushed. */
  onEvent(cb: (ev: string, payload: unknown) => void): void;
  /** Subscribe to source loss (attached: socket close). Embedded: never fires. */
  onDisconnect(cb: () => void): void;
  /** Request a fresh status snapshot (attached only; embedded resolves null). */
  refreshStatus(): Promise<BackupSnapshot | null>;
  /** Start a run. Attached: the daemon owns it; embedded: in-process. */
  runNow(kind?: 'incremental' | 'reconcile'): void;
  /** Cooperatively cancel the active run. */
  cancel(): void;
  /** Push new throttle knobs (attached: live to the daemon). */
  setRate(update: { concurrency?: number; maxMbps?: number }): void;
  /**
   * Detach. Attached: ONLY closes the socket — the daemon and any in-flight
   * backup run keep going. Embedded: cancels the in-process run (nothing must
   * outlive the UI).
   */
  close(): void;
}

// ---- Attached ---------------------------------------------------------------

class AttachedBackupSource implements BackupDashboardSource {
  readonly mode = 'attached' as const;
  readonly snapshot: BackupSnapshot;

  private eventCb: ((ev: string, payload: unknown) => void) | null = null;
  private readonly pendingEvents: Array<[string, unknown]> = [];

  constructor(
    private readonly client: DaemonClient,
    snapshot: BackupSnapshot,
  ) {
    this.snapshot = snapshot;
  }

  /** @internal wired by createAttachedBackupSource's onMessage handler. */
  _dispatch(msg: DaemonMessage): void {
    if (msg.kind !== 'backup-event') return;
    const ev = typeof msg.ev === 'string' ? msg.ev : '';
    if (!ev) return;
    if (this.eventCb) this.eventCb(ev, msg.payload);
    else this.pendingEvents.push([ev, msg.payload]);
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

  async refreshStatus(): Promise<BackupSnapshot | null> {
    this.client.send({ cmd: 'backup-status' });
    try {
      const msg = await this.client.waitFor((m) => m.kind === 'backup-status', 5000);
      return parseBackupSnapshot(msg);
    } catch {
      return null;
    }
  }

  runNow(kind: 'incremental' | 'reconcile' = 'incremental'): void {
    this.client.send({ cmd: 'backup-run-now', kind });
  }

  cancel(): void {
    this.client.send({ cmd: 'backup-cancel' });
  }

  setRate(update: { concurrency?: number; maxMbps?: number }): void {
    this.client.send({ cmd: 'backup-set-rate', ...update });
  }

  close(): void {
    // Never stops the daemon or its run — just detaches this dashboard.
    this.client.close();
  }
}

/**
 * Connect to a running daemon and build an attached source. Resolves once the
 * `backup-status` reply has arrived; rejects when nothing is listening or the
 * daemon has no bound backup root (`configured: false`).
 */
export async function createAttachedBackupSource(
  socketPath?: string,
  timeoutMs?: number,
): Promise<BackupDashboardSource> {
  const client = await connectToDaemon(socketPath, timeoutMs);
  try {
    let source: AttachedBackupSource | null = null;
    const early: DaemonMessage[] = [];
    client.onMessage((msg) => {
      if (source) source._dispatch(msg);
      else early.push(msg);
    });

    client.send({ cmd: 'backup-status' });
    const statusMsg = await client.waitFor((m) => m.kind === 'backup-status', 5000);
    const snapshot = parseBackupSnapshot(statusMsg);
    if (!snapshot.configured) {
      throw new Error(
        'the running daemon has no backup root bound (it started before `memoriahub backup init`)',
      );
    }
    source = new AttachedBackupSource(client, snapshot);
    for (const msg of early) source._dispatch(msg);
    return source;
  } catch (err) {
    client.close();
    throw err;
  }
}

// ---- Embedded ---------------------------------------------------------------

/** What the embedded source needs from an in-process engine. */
export type EmbeddableBackupEngine = BackupTypedEmitter & { cancel(): void };

/**
 * Embedded source: wraps an in-process BackupEngine the dashboard constructs
 * lazily (on [r]). Events are forwarded through the same onEvent callback the
 * attached source uses, so the component's reducer path is identical.
 */
export class EmbeddedBackupSource implements BackupDashboardSource {
  readonly mode = 'embedded' as const;
  readonly snapshot: BackupSnapshot | null = null;

  private engine: EmbeddableBackupEngine | null = null;
  private eventCb: ((ev: string, payload: unknown) => void) | null = null;
  private readonly pendingEvents: Array<[string, unknown]> = [];
  private closed = false;
  /** Set by the component; starts one in-process run. */
  private starter: ((kind: 'incremental' | 'reconcile') => void) | null = null;

  /** Whether a run engine is currently attached. */
  get hasEngine(): boolean {
    return this.engine !== null;
  }

  /** Register the callback that constructs + runs an in-process engine. */
  setStarter(fn: (kind: 'incremental' | 'reconcile') => void): void {
    this.starter = fn;
  }

  /** Attach a freshly-constructed engine and subscribe to all its events. */
  attachEngine(engine: EmbeddableBackupEngine): void {
    this.engine = engine;
    const emitter = engine as unknown as {
      on(event: string, listener: (payload: unknown) => void): void;
    };
    for (const ev of Object.values(BACKUP_EV)) {
      emitter.on(ev, (payload: unknown) => this.emit(ev, payload));
    }
  }

  /** Drop the engine reference once its run has settled. */
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
    // An in-process engine cannot "disconnect"; run-finished covers shutdown.
  }

  async refreshStatus(): Promise<BackupSnapshot | null> {
    return null;
  }

  runNow(kind: 'incremental' | 'reconcile' = 'incremental'): void {
    if (this.engine) return; // one run at a time, mirroring BackupHost
    this.starter?.(kind);
  }

  cancel(): void {
    this.engine?.cancel();
  }

  setRate(_update: { concurrency?: number; maxMbps?: number }): void {
    // Embedded runs read their knobs at construction; persistence is the
    // settings screen's job.
  }

  close(): void {
    this.closed = true;
    const e = this.engine;
    if (e) {
      e.removeAllListeners();
      e.cancel();
      this.engine = null;
    }
  }
}

/**
 * Pick the data source: attach to a running daemon when one is up AND has a
 * backup root bound, otherwise fall back to the embedded engine. Mirrors
 * NodeDashboard.initSource so both dashboards behave identically.
 */
export async function selectBackupSource(deps: {
  isDaemonRunning: () => Promise<boolean>;
  createAttached: () => Promise<BackupDashboardSource>;
}): Promise<BackupDashboardSource> {
  try {
    if (await deps.isDaemonRunning()) {
      return await deps.createAttached();
    }
  } catch {
    // Daemon vanished between probe and connect, or has no bound root —
    // embedded is always a valid fallback.
  }
  return new EmbeddedBackupSource();
}
