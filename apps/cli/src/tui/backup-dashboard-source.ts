/**
 * tui/backup-dashboard-source.ts — the backup dashboard as a platform dashboard
 * (RETRO-F4, #582): the shared state model, a pure reducer and the two feeds
 * BackupDashboard.tsx follows.
 *
 * Deliberately the SAME shape as tui/node-dashboard-source.ts, because the two
 * dashboards have the same problem: the work can be happening in a detached
 * daemon or in this process, and the view must not care which.
 *
 *   - ATTACHED: a `memoriahub node start --daemon` process is running with a
 *     bound backup root. The platform's `daemonAttachFeed` (channel `backup`)
 *     connects to its NDJSON IPC socket through the 1.3 protocol adapter
 *     (legacy-daemon.ts), hydrates from a `backup-status` reply, and applies live
 *     `{kind:'backup-event', ev, payload}` frames. Closing DETACHES: it never
 *     stops the daemon or its backup run.
 *   - EMBEDDED: no daemon is running; the dashboard owns an in-process
 *     BackupEngine and `embeddedBackupFeed` follows its typed events.
 *
 * Both feed the SAME pure reducer (reduceBackupEvent) over one
 * BackupDashboardState, so the React component has exactly one update path.
 * The reducer and the snapshot parser are plain functions: unit-testable
 * without Ink or sockets. Commands (run now, cancel, set rate) are not part of an
 * attach feed: `daemonBackupControl` sends each over a short-lived connection.
 */

import {
  DashboardSource,
  daemonAttachFeed,
  type DashboardFeed,
  type DashboardReducer,
} from '@marinoscar/platform-cli/tui';

import { connectToDaemon, sendBackupCommand } from '../backup/ipc-client.js';
import { nodeSocketPathOf } from '../executors/state-dir.js';

/** What a backup channel `event` frame carries: the host's `{ ev, payload }`. */
function parseLegacyEvent(frame: unknown): { ev: string; payload: unknown } | undefined {
  if (frame === null || typeof frame !== 'object') return undefined;
  const { ev, payload } = frame as { ev?: unknown; payload?: unknown };
  return typeof ev === 'string' && ev.length > 0 ? { ev, payload } : undefined;
}
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

/** A log line stamped with the next sequence id (ids order lines from several writers). */
export function makeBackupLogEntry(level: BackupLogLevel, msg: string, atMs: number): BackupLogEntry {
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
  const log = [...state.log, ...entries.map((e) => makeBackupLogEntry(e.level, e.msg, nowMs))].slice(
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
// Platform dashboard pieces: reducer, feeds, controls
// ---------------------------------------------------------------------------

/** One engine event as the reducer folds it; `atMs` is when the dashboard saw it. */
export interface BackupDashEvent {
  ev: string;
  payload: unknown;
  atMs: number;
}

export type BackupDashboardSource = DashboardSource<BackupDashboardState, BackupDashEvent>;

/**
 * The pure reducer behind the dashboard. `seed` starts a replacement source from the state already
 * on screen (a second in-process run keeps the first one's counters and run history).
 */
export function backupDashboardReducer(
  seed?: BackupDashboardState,
): DashboardReducer<BackupDashboardState, BackupDashEvent> {
  return {
    initial: () => seed ?? initialBackupDashboardState(),
    hydrate: (state, snapshot) =>
      hydrateFromBackupSnapshot(state, parseBackupSnapshot((snapshot ?? {}) as Record<string, unknown>), Date.now()),
    reduce: (state, event) => reduceBackupEvent(state, event.ev, event.payload, event.atMs),
    parseEvent: (frame) => {
      const parsed = parseLegacyEvent(frame);
      return parsed ? { ev: parsed.ev, payload: parsed.payload, atMs: Date.now() } : undefined;
    },
  };
}

/** Attach (read-only, reconnecting) to the worker daemon's backup channel. */
export function backupDaemonFeed(socketPath: string = nodeSocketPathOf()): DashboardFeed<BackupDashEvent> {
  return daemonAttachFeed<BackupDashEvent>({ socketPath, channel: 'backup' });
}

/** What the embedded feed needs from an in-process engine. */
export type EmbeddableBackupEngine = BackupTypedEmitter & { cancel(): void };

/**
 * Follow an in-process BackupEngine's typed events. Stopping the feed only detaches the listeners;
 * cancelling the run is the component's job on unmount.
 */
export function embeddedBackupFeed(engine: EmbeddableBackupEngine): DashboardFeed<BackupDashEvent> {
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
      for (const ev of Object.values(BACKUP_EV)) {
        emitter.on(ev, (payload: unknown) => {
          if (!stopped) emit({ kind: 'event', event: { ev, payload, atMs: Date.now() } });
        });
      }
    },
    stop() {
      stopped = true;
      emitter.removeAllListeners();
    },
  };
}

/** A dashboard source over `feed`; `seed` carries the state of the source it replaces. */
export function createBackupSource(
  feed: DashboardFeed<BackupDashEvent>,
  seed?: BackupDashboardState,
): BackupDashboardSource {
  return new DashboardSource(backupDashboardReducer(seed), feed);
}

/** What the dashboard can ask of whatever is doing the work. */
export interface BackupControl {
  /** Start a run. Attached: the daemon owns it; embedded: in-process. */
  runNow(kind?: 'incremental' | 'reconcile'): void;
  /** Cooperatively cancel the active run. */
  cancel(): void;
  /** Push new throttle knobs (attached: live to the daemon). */
  setRate(update: { concurrency?: number; maxMbps?: number }): void;
}

/** Controls for a daemon: each command goes over its own short-lived connection. */
export function daemonBackupControl(socketPath?: string): BackupControl {
  const send = (command: Record<string, unknown>): void => {
    void sendBackupCommand(command, { socketPath }).catch(() => undefined);
  };
  return {
    runNow: (kind = 'incremental') => send({ cmd: 'backup-run-now', kind }),
    cancel: () => send({ cmd: 'backup-cancel' }),
    setRate: (update) => send({ cmd: 'backup-set-rate', ...update }),
  };
}

/**
 * Controls for an in-process run: `start` constructs and runs an engine (one run at a time, mirroring
 * BackupHost) and `engine` is the one running now, if any.
 */
export function embeddedBackupControl(deps: {
  start: (kind: 'incremental' | 'reconcile') => void;
  engine: () => EmbeddableBackupEngine | null;
}): BackupControl {
  return {
    runNow: (kind = 'incremental') => {
      if (deps.engine()) return;
      deps.start(kind);
    },
    cancel: () => deps.engine()?.cancel(),
    // Embedded runs read their knobs at construction; persistence is the settings screen's job.
    setRate: () => undefined,
  };
}

/**
 * Ask a running daemon for its backup status. Resolves with the snapshot, or `null` when nothing is
 * listening, the daemon answers nothing in time, or it has no bound backup root (`configured: false`:
 * it started before `memoriahub backup init`).
 */
export async function probeBackupDaemon(
  socketPath?: string,
  timeoutMs?: number,
  connect: typeof connectToDaemon = connectToDaemon,
): Promise<BackupSnapshot | null> {
  let client;
  try {
    client = await connect(socketPath, timeoutMs);
  } catch {
    return null;
  }
  try {
    client.send({ cmd: 'backup-status' });
    const reply = await client.waitFor((m) => m.kind === 'backup-status', 5000);
    const snapshot = parseBackupSnapshot(reply);
    return snapshot.configured ? snapshot : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

/** Where the dashboard reads from. */
export type BackupSourceChoice =
  | { mode: 'attached'; snapshot: BackupSnapshot }
  | { mode: 'embedded' };

/**
 * Pick the data source: attach to a running daemon when one is up AND has a backup root bound,
 * otherwise fall back to the embedded engine. Mirrors NodeDashboard.initSource so both dashboards
 * behave identically.
 */
export async function selectBackupSource(deps: {
  isDaemonRunning: () => Promise<boolean>;
  probe: () => Promise<BackupSnapshot | null>;
}): Promise<BackupSourceChoice> {
  try {
    if (await deps.isDaemonRunning()) {
      const snapshot = await deps.probe();
      if (snapshot) return { mode: 'attached', snapshot };
    }
  } catch {
    // Daemon vanished between probe and connect, or has no bound root:
    // embedded is always a valid fallback.
  }
  return { mode: 'embedded' };
}
