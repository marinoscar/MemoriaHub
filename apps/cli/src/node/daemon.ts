/**
 * node/daemon.ts — Daemon host: pidfile + NDJSON IPC socket for a running
 * worker-node engine.
 *
 * Any `node start` run hosts this alongside the engine, making the process
 * attachable: a second CLI instance (`node status`, `node stop`,
 * `node set-concurrency`, a future TUI attach mode) connects to the unix
 * socket (named pipe on Windows) and speaks one JSON object per line.
 *
 * Server → client frames:
 *   { kind: 'snapshot', ...EngineSnapshot }        — sent once on connect
 *   { kind: 'log-tail', lines: string[] }          — recent log lines on connect
 *   { kind: 'event', ev, payload, ts }             — every engine event, live
 *   { kind: 'backup-event', ev, payload, ts }      — every BackupEngine event,
 *                                                    live (issue #318; only when
 *                                                    a BackupHost is attached)
 *   { kind: 'status', ...EngineSnapshot }          — reply to { cmd: 'status' }
 *   { kind: 'backup-status', ...BackupHostSnapshot } — reply to
 *                                                    { cmd: 'backup-status' }
 *   { kind: 'ack', cmd, ... }                      — command acknowledged
 *   { kind: 'error', message, cmd?, code? }        — malformed/unknown command,
 *                                                    or a command-scoped failure
 *                                                    (code 'busy' /
 *                                                    'not-configured' for the
 *                                                    backup verbs)
 *
 * Client → server commands (one JSON per line):
 *   { cmd: 'status' } | { cmd: 'set-concurrency', value } |
 *   { cmd: 'drain' } | { cmd: 'stop' } | { cmd: 'heap-snapshot' } |
 *   { cmd: 'backup-status' } | { cmd: 'backup-run-now' } |
 *   { cmd: 'backup-cancel' } | { cmd: 'backup-set-rate', concurrency?, maxMbps? }
 *
 * Backup hosting (issue #318): when `node start` finds a bound backup root it
 * passes a BackupHost in DaemonHostOptions. The daemon then serves the four
 * backup-* verbs and re-broadcasts the host's engine events. Backup and
 * enrichment share ONLY the process — independent concurrency, and the
 * BackupHost uses its OWN ApiClient because the CooldownGate is per-client
 * (an enrichment provider cooldown must never brake backup, or vice versa).
 * Without a BackupHost, backup-status answers { configured: false } and the
 * other backup verbs reply with a 'not-configured' error frame.
 *
 * `heap-snapshot` is the diagnostic escape hatch for issue #156: it makes the
 * LIVE daemon serialize its V8 heap to a file so a slow leak can be pinned
 * without restarting the process (a restart discards exactly the accumulated
 * state you need to inspect). The write is synchronous and stops the world for
 * seconds on a multi-GB heap — deliberate, since it is an explicit operator
 * action; in-flight leases are renewed on a far shorter cadence than the
 * server's lease window, so a stalled tick is harmless.
 *
 * Lifecycle safety:
 *   - A stale pidfile (dead pid) is removed; a live one refuses startup.
 *   - A stale socket file (unconnectable) is unlinked before listen.
 *   - Socket + pidfile are cleaned up when the engine emits 'stopped' and,
 *     best-effort, on process exit — so SIGTERM/SIGINT paths (which route
 *     through engine.stop()) always clean up.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import { nodePidPath, nodeSocketPath } from '../paths.js';
import { loadConfig, saveConfig } from '../config.js';
import { NdjsonParser, encodeNdjson } from './ndjson.js';
import { NODE_EV } from './node-events.js';
import {
  writeWorkerHeapSnapshot,
  describeHeapSnapshotResult,
  type HeapSnapshotOptions,
  type HeapSnapshotResult,
} from './heap-snapshot.js';
import type { NodeEngine } from './node-engine.js';
import type { NodeLogger } from './logger.js';
// Deliberately type-only + events-only: daemon.ts is imported by the TUI
// dashboard (readPidFile), so it must NOT pull the backup engine's runtime
// graph (ApiClient/ApiError/better-sqlite3) into every consumer's module
// graph. The BackupHost VALUE is constructed by `node start` and injected
// via DaemonHostOptions; events.ts has no runtime dependencies.
import { BACKUP_HOST_EVENT, type BackupHostEventFrame } from '../backup/events.js';
import type { BackupHost } from '../backup/backup-host.js';

/**
 * Maximum bytes allowed to queue in one IPC client's socket before the daemon
 * drops it. Sized well above any legitimate burst (a snapshot frame for a
 * 50-job history is a few KB) and far below anything that matters to a worker's
 * memory budget. See `send()` for why an unread socket is a genuine retainer.
 */
export const MAX_CLIENT_BACKLOG_BYTES = 1024 * 1024;

/** Contents of the daemon pidfile (JSON). */
export interface DaemonPidInfo {
  pid: number;
  startedAt: string;
  socketPath: string;
}

export interface DaemonHostOptions {
  /** Override the IPC endpoint (default nodeSocketPath()). */
  socketPath?: string;
  /** Override the pidfile location (default nodePidPath()). */
  pidPath?: string;
  /** Number of recent log lines sent to a client on connect (default 20). */
  logTailLines?: number;
  /**
   * Write-backlog cap per IPC client before it is dropped (default
   * MAX_CLIENT_BACKLOG_BYTES). Injectable so tests can force the drop without
   * having to queue a megabyte of frames.
   */
  maxClientBacklogBytes?: number;
  /**
   * Persist a live concurrency change (default: write NodeConfig.concurrency
   * via loadConfig/saveConfig; no-op when no config exists). Injectable so
   * tests/harnesses never touch the real ~/.memoriahub/config.json.
   */
  persistConcurrency?: (n: number) => void;
  /** Process-exit hook used by the 'stop' command (default process.exit). */
  exit?: (code: number) => void;
  /**
   * Heap-snapshot writer for the 'heap-snapshot' command (default
   * `writeWorkerHeapSnapshot`). Injectable so tests exercise the command
   * without serializing a real multi-hundred-MB Jest heap to disk.
   */
  heapSnapshotFn?: (opts?: HeapSnapshotOptions) => HeapSnapshotResult;
  /**
   * Backup hosting (issue #318): serve the backup-* IPC verbs and
   * re-broadcast BackupEngine events. Absent when no backup root is bound —
   * the daemon then runs enrichment-only.
   */
  backupHost?: BackupHost;
}

export interface DaemonHost {
  socketPath: string;
  pidPath: string;
  /** Detach listeners, close all client sockets, remove socket + pidfile. */
  close(): Promise<void>;
}

/** Read and parse the pidfile; null when absent or unparseable. */
export function readPidFile(pidPath: string = nodePidPath()): DaemonPidInfo | null {
  try {
    const raw = fs.readFileSync(pidPath, 'utf-8');
    const parsed = JSON.parse(raw) as DaemonPidInfo;
    if (typeof parsed?.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when `pid` refers to a live process (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Probe-connect to a socket path; resolves true when something accepts. */
function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const finish = (alive: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Default persistence for set-concurrency: merge into NodeConfig. */
function defaultPersistConcurrency(n: number): void {
  const cfg = loadConfig();
  if (!cfg) return;
  saveConfig({ ...cfg, node: { ...cfg.node, concurrency: n } });
}

/**
 * Start the daemon host for a (started or about-to-start) engine: write the
 * pidfile, listen on the IPC socket, broadcast engine events to connected
 * clients, and serve control commands.
 *
 * Throws when another daemon is already running (live pidfile or a socket
 * that accepts connections).
 */
export async function startDaemonHost(
  engine: NodeEngine,
  logger: NodeLogger,
  opts: DaemonHostOptions = {},
): Promise<DaemonHost> {
  const socketPath = opts.socketPath ?? nodeSocketPath();
  const pidPath = opts.pidPath ?? nodePidPath();
  const logTailLines = opts.logTailLines ?? 20;
  const maxBacklogBytes = opts.maxClientBacklogBytes ?? MAX_CLIENT_BACKLOG_BYTES;
  const persistConcurrency = opts.persistConcurrency ?? defaultPersistConcurrency;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const writeHeapSnapshot = opts.heapSnapshotFn ?? writeWorkerHeapSnapshot;
  const backupHost = opts.backupHost;
  const isWindows = os.platform() === 'win32';

  // ---- Stale-instance detection -------------------------------------------
  const existing = readPidFile(pidPath);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      throw new Error(`worker node daemon already running (pid ${existing.pid})`);
    }
    // Stale pidfile from a crashed daemon — remove and continue.
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* best-effort */
    }
  }
  if (!isWindows && fs.existsSync(socketPath)) {
    if (await probeSocket(socketPath)) {
      throw new Error(`worker node daemon already running (socket ${socketPath} is live)`);
    }
    // Unconnectable leftover socket file — unlink so listen() succeeds.
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* best-effort */
    }
  }

  // ---- Pidfile -------------------------------------------------------------
  const pidInfo: DaemonPidInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    socketPath,
  };
  fs.writeFileSync(pidPath, JSON.stringify(pidInfo, null, 2), { mode: 0o600 });

  // ---- IPC server ----------------------------------------------------------
  const clients = new Set<net.Socket>();
  let closed = false;

  const send = (socket: net.Socket, frame: Record<string, unknown>): void => {
    // A client that stops reading (suspended terminal, SIGSTOP'd TUI, a peer
    // that half-closed without us noticing) does NOT make write() fail — Node
    // buffers the frame in the socket's writable queue instead. Under
    // sustained load the daemon emits several frames per job, so an unnoticed
    // stalled reader turns into an unbounded, job-count-linear accumulation of
    // strings on the heap. Issue #156's audit recorded the IPC host as
    // "buffers nothing per event", which is only true of a reader that keeps
    // up. Drop a client whose backlog crosses the cap: this is a diagnostic
    // channel, and a detached dashboard is worth strictly less than the
    // worker's memory.
    if (socket.writableLength > maxBacklogBytes) {
      logger.warn('dropping unresponsive ipc client (write backlog exceeded)', {
        backlogBytes: socket.writableLength,
        limitBytes: maxBacklogBytes,
      });
      clients.delete(socket);
      socket.destroy();
      return;
    }
    try {
      socket.write(encodeNdjson(frame));
    } catch {
      /* client went away mid-write */
    }
  };

  const broadcast = (frame: Record<string, unknown>): void => {
    for (const socket of clients) send(socket, frame);
  };

  const handleCommand = async (socket: net.Socket, msg: unknown): Promise<void> => {
    const cmd =
      msg !== null && typeof msg === 'object' ? (msg as { cmd?: unknown }).cmd : undefined;
    switch (cmd) {
      case 'status': {
        send(socket, { kind: 'status', ...engine.getSnapshot() });
        break;
      }
      case 'set-concurrency': {
        const value = Number((msg as { value?: unknown }).value);
        if (!Number.isInteger(value) || value < 1 || value > 64) {
          send(socket, {
            kind: 'error',
            message: 'set-concurrency requires an integer value between 1 and 64',
          });
          break;
        }
        engine.setConcurrency(value);
        try {
          persistConcurrency(value);
        } catch {
          /* live change applied; persistence is best-effort */
        }
        logger.info('concurrency changed via ipc', { value });
        send(socket, { kind: 'ack', cmd: 'set-concurrency', value });
        break;
      }
      case 'heap-snapshot': {
        const res = writeHeapSnapshot({ reason: 'manual' });
        const summary = describeHeapSnapshotResult(res);
        logger.log(res.ok ? 'info' : 'warn', { ev: 'heap-snapshot', msg: summary, ...res });
        if (!res.ok) {
          send(socket, { kind: 'error', message: summary });
          break;
        }
        send(socket, {
          kind: 'ack',
          cmd: 'heap-snapshot',
          path: res.path,
          bytes: res.bytes,
          durationMs: res.durationMs,
        });
        break;
      }
      // ---- Backup verbs (issue #318) --------------------------------------
      case 'backup-status': {
        if (!backupHost) {
          send(socket, {
            kind: 'backup-status',
            configured: false,
            running: null,
            lastRun: null,
            checkpoint: null,
            counters: null,
            rate: null,
          });
          break;
        }
        send(socket, { kind: 'backup-status', ...backupHost.getSnapshot() });
        break;
      }
      case 'backup-run-now': {
        if (!backupHost) {
          send(socket, {
            kind: 'error',
            cmd: 'backup-run-now',
            code: 'not-configured',
            message:
              'backup is not configured on this daemon (run `memoriahub backup init` and restart the node)',
          });
          break;
        }
        try {
          const kind =
            (msg as { kind?: unknown }).kind === 'reconcile'
              ? ('reconcile' as const)
              : ('incremental' as const);
          backupHost.startRun('manual', kind);
          logger.info('backup run started via ipc', { kind });
          send(socket, { kind: 'ack', cmd: 'backup-run-now' });
        } catch (err) {
          // Duck-typed (not instanceof BackupBusyError) so this module never
          // needs a runtime import from backup-host.js — see the import note.
          if ((err as { code?: unknown })?.code === 'busy') {
            send(socket, {
              kind: 'error',
              cmd: 'backup-run-now',
              code: 'busy',
              message: err instanceof Error ? err.message : String(err),
            });
          } else {
            send(socket, {
              kind: 'error',
              cmd: 'backup-run-now',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }
      case 'backup-cancel': {
        if (!backupHost) {
          send(socket, {
            kind: 'error',
            cmd: 'backup-cancel',
            code: 'not-configured',
            message: 'backup is not configured on this daemon',
          });
          break;
        }
        const cancelled = backupHost.cancel();
        if (cancelled) logger.info('backup run cancel requested via ipc');
        send(socket, { kind: 'ack', cmd: 'backup-cancel', cancelled });
        break;
      }
      case 'backup-set-rate': {
        if (!backupHost) {
          send(socket, {
            kind: 'error',
            cmd: 'backup-set-rate',
            code: 'not-configured',
            message: 'backup is not configured on this daemon',
          });
          break;
        }
        const body = msg as { concurrency?: unknown; maxMbps?: unknown };
        const update: { concurrency?: number; maxMbps?: number } = {};
        if (body.concurrency !== undefined) {
          const value = Number(body.concurrency);
          if (!Number.isInteger(value) || value < 1 || value > 32) {
            send(socket, {
              kind: 'error',
              cmd: 'backup-set-rate',
              message: 'backup-set-rate requires an integer concurrency between 1 and 32',
            });
            break;
          }
          update.concurrency = value;
        }
        if (body.maxMbps !== undefined) {
          const value = Number(body.maxMbps);
          if (!Number.isFinite(value) || value < 0) {
            send(socket, {
              kind: 'error',
              cmd: 'backup-set-rate',
              message: 'backup-set-rate requires a non-negative maxMbps (0 = unlimited)',
            });
            break;
          }
          update.maxMbps = value;
        }
        if (update.concurrency === undefined && update.maxMbps === undefined) {
          send(socket, {
            kind: 'error',
            cmd: 'backup-set-rate',
            message: 'backup-set-rate requires concurrency and/or maxMbps',
          });
          break;
        }
        const effective = backupHost.setRate(update);
        logger.info('backup rate changed via ipc', { ...effective });
        send(socket, { kind: 'ack', cmd: 'backup-set-rate', ...effective });
        break;
      }
      case 'drain': {
        engine.drain();
        logger.info('drain requested via ipc');
        send(socket, { kind: 'ack', cmd: 'drain' });
        break;
      }
      case 'stop': {
        logger.info('stop requested via ipc');
        send(socket, { kind: 'ack', cmd: 'stop' });
        // Graceful: drain in-flight work, deregister, clean up (via the
        // 'stopped' listener below), then exit once the ack has flushed.
        await engine.stop('ipc');
        const bail = setTimeout(() => exit(0), 500);
        bail.unref?.();
        socket.end(() => exit(0));
        break;
      }
      default: {
        send(socket, { kind: 'error', message: `unknown command: ${String(cmd)}` });
      }
    }
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf-8');
    socket.on('error', () => {
      /* client reset — cleaned up on 'close' */
    });
    socket.on('close', () => clients.delete(socket));

    // Greeting: current snapshot + recent log tail.
    send(socket, { kind: 'snapshot', ...engine.getSnapshot() });
    send(socket, { kind: 'log-tail', lines: logger.tail(logTailLines) });

    const parser = new NdjsonParser();
    socket.on('data', (chunk) => {
      for (const res of parser.push(chunk)) {
        if (!res.ok) {
          send(socket, { kind: 'error', message: `malformed command: ${res.error}` });
          continue;
        }
        void handleCommand(socket, res.value);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  if (!isWindows) {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* best-effort — the parent dir is already user-only */
    }
  }

  // ---- Engine event re-broadcast ------------------------------------------
  const emitter = engine as unknown as {
    on(event: string, listener: (payload: unknown) => void): void;
    off(event: string, listener: (payload: unknown) => void): void;
  };
  const subscriptions: Array<[string, (payload: unknown) => void]> = [];
  for (const ev of Object.values(NODE_EV)) {
    const listener = (payload: unknown): void => {
      broadcast({ kind: 'event', ev, payload, ts: new Date().toISOString() });
    };
    emitter.on(ev, listener);
    subscriptions.push([ev, listener]);
  }

  // BackupHost events (issue #318): the host re-emits every BackupEngine
  // event as one 'backup-event' emission; the daemon frames it for IPC.
  const backupListener = (frame: BackupHostEventFrame): void => {
    broadcast({
      kind: 'backup-event',
      ev: frame.ev,
      payload: frame.payload,
      ts: new Date().toISOString(),
    });
  };
  backupHost?.on(BACKUP_HOST_EVENT, backupListener);

  // ---- Cleanup --------------------------------------------------------------
  const cleanupFiles = (): void => {
    if (!isWindows) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    }
    try {
      // Only remove OUR pidfile — never one written by a newer instance.
      const current = readPidFile(pidPath);
      if (current && current.pid === process.pid) fs.unlinkSync(pidPath);
    } catch {
      /* already gone */
    }
  };

  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    for (const [ev, listener] of subscriptions) emitter.off(ev, listener);
    if (backupHost) {
      backupHost.off(BACKUP_HOST_EVENT, backupListener);
      // Stop the scheduler poll; an in-flight backup run completes on its own
      // (its timers/sockets are what keep the process alive if needed).
      backupHost.stopScheduler();
    }
    for (const socket of clients) socket.destroy();
    clients.clear();
    process.removeListener('exit', cleanupFiles);
    return new Promise((resolve) => {
      server.close(() => {
        cleanupFiles();
        resolve();
      });
    });
  };

  // Engine shutdown (Ctrl-C / SIGTERM handlers call engine.stop, IPC 'stop'
  // does too) tears the host down so the process can exit naturally.
  engine.once(NODE_EV.STOPPED, () => {
    void close();
  });
  // Last-resort cleanup if the process exits without a graceful stop.
  process.on('exit', cleanupFiles);

  logger.info('daemon host listening', { socketPath, pidPath, pid: process.pid });

  return { socketPath, pidPath, close };
}
