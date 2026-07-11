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
 *   { kind: 'status', ...EngineSnapshot }          — reply to { cmd: 'status' }
 *   { kind: 'ack', cmd, ... }                      — command acknowledged
 *   { kind: 'error', message }                     — malformed/unknown command
 *
 * Client → server commands (one JSON per line):
 *   { cmd: 'status' } | { cmd: 'set-concurrency', value } |
 *   { cmd: 'drain' } | { cmd: 'stop' }
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
import type { NodeEngine } from './node-engine.js';
import type { NodeLogger } from './logger.js';

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
   * Persist a live concurrency change (default: write NodeConfig.concurrency
   * via loadConfig/saveConfig; no-op when no config exists). Injectable so
   * tests/harnesses never touch the real ~/.memoriahub/config.json.
   */
  persistConcurrency?: (n: number) => void;
  /** Process-exit hook used by the 'stop' command (default process.exit). */
  exit?: (code: number) => void;
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
  const persistConcurrency = opts.persistConcurrency ?? defaultPersistConcurrency;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
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
