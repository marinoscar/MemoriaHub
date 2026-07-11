/**
 * node/logger.ts — JSONL file logger for the worker-node daemon.
 *
 * Writes one JSON object per line to ~/.memoriahub/logs/node.log so a
 * detached daemon leaves an inspectable trail (`memoriahub node logs`).
 *
 * Design points:
 *   - Size-based rotation: when the file would exceed `maxBytes` (default
 *     5 MB), node.log is renamed to node.log.1 (a single rollover generation)
 *     and a fresh node.log is started.
 *   - Redaction: field names that look like secrets (pat/token/apiKey/secret/
 *     credential/password) are recursively replaced with '[REDACTED]' before
 *     serialization — a presigned URL or PAT must never land in a log file.
 *   - Synchronous appends: log volume is low (engine events, not per-byte
 *     progress) and sync writes survive crashes without a flush step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logsDir } from '../paths.js';
import { NODE_EV, type NodeEventName } from './node-events.js';
import type { NodeEngine } from './node-engine.js';

export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NodeLogger {
  /** Absolute path of the active log file. */
  readonly logPath: string;
  /** Write one structured line: { ts, level, ...fields } (redacted). */
  log(level: NodeLogLevel, fields: Record<string, unknown>): void;
  info(msg: string, payload?: Record<string, unknown>): void;
  warn(msg: string, payload?: Record<string, unknown>): void;
  error(msg: string, payload?: Record<string, unknown>): void;
  /** Return the last `n` raw lines (spanning the rollover file if needed). */
  tail(n: number): string[];
}

/** Default rotation threshold: 5 MB. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Base name of the worker-node log file. */
export const NODE_LOG_FILENAME = 'node.log';

/**
 * Field names that must never be logged. Matches the exact name `pat` (so
 * `path`/`pattern` survive) or any name containing token/apiKey/api_key/
 * secret/credential/password, case-insensitively.
 */
const SENSITIVE_KEY = /^pat$|token|api[-_]?key|apikey|secret|credential|password/i;

const REDACTED = '[REDACTED]';
const MAX_REDACT_DEPTH = 8;

/** Recursively replace sensitive-named fields with '[REDACTED]'. */
export function redactSensitive(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[MaxDepth]';
  const tracker = seen ?? new WeakSet<object>();
  if (tracker.has(value)) return '[Circular]';
  tracker.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1, tracker));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(v, depth + 1, tracker);
  }
  return out;
}

/** Absolute path of the node log file for a given (or default) directory. */
export function nodeLogPath(dir?: string): string {
  return path.join(dir ?? logsDir(), NODE_LOG_FILENAME);
}

/**
 * Read the last `n` lines of the node log, spanning into node.log.1 when the
 * active file has fewer than `n` lines. Returns oldest→newest order.
 */
export function readLastLines(n: number, dir?: string): string[] {
  const logPath = nodeLogPath(dir);
  const lines: string[] = [];
  for (const p of [logPath + '.1', logPath]) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      lines.push(...content.split('\n').filter((l) => l.trim() !== ''));
    } catch {
      /* file may not exist yet */
    }
  }
  return lines.slice(-Math.max(0, n));
}

/**
 * Tail the node log: invoke `onLine` for every complete line appended after
 * this call. Survives rotation (watches the directory, resets its offset when
 * the file shrinks or is replaced). Returns an unsubscribe function.
 */
export function followLog(onLine: (line: string) => void, dir?: string): () => void {
  const resolvedDir = dir ?? logsDir();
  const logPath = nodeLogPath(resolvedDir);
  // Ensure the file exists so we can establish a starting offset.
  try {
    fs.closeSync(fs.openSync(logPath, 'a'));
  } catch {
    /* best-effort */
  }
  let offset = 0;
  try {
    offset = fs.statSync(logPath).size;
  } catch {
    offset = 0;
  }
  let partial = '';

  const drain = (): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return; // mid-rotation; next event will re-read
    }
    if (stat.size < offset) {
      // Rotated (renamed away and restarted): start from the top of the new file.
      offset = 0;
      partial = '';
    }
    if (stat.size === offset) return;
    let fd: number;
    try {
      fd = fs.openSync(logPath, 'r');
    } catch {
      return;
    }
    try {
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, offset);
      offset += read;
      partial += buf.subarray(0, read).toString('utf-8');
      let idx: number;
      while ((idx = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, idx);
        partial = partial.slice(idx + 1);
        if (line.trim() !== '') onLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  // Watch the directory (not the file) so rotation renames don't detach us.
  const watcher = fs.watch(resolvedDir, (_event, filename) => {
    if (filename === null || filename === NODE_LOG_FILENAME) drain();
  });

  return () => {
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  };
}

/** Create a JSONL file logger writing node.log under `opts.dir` (default logsDir()). */
export function createNodeLogger(opts: { dir?: string; maxBytes?: number } = {}): NodeLogger {
  const dir = opts.dir ?? logsDir();
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const logPath = path.join(dir, NODE_LOG_FILENAME);

  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    size = 0;
  }

  const write = (level: NodeLogLevel, fields: Record<string, unknown>): void => {
    const scrubbed = redactSensitive(fields) as Record<string, unknown>;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, ...scrubbed }) + '\n';
    } catch {
      line =
        JSON.stringify({ ts: new Date().toISOString(), level, msg: '[unserializable log entry]' }) +
        '\n';
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      // One rollover generation: node.log → node.log.1 (replacing any prior .1).
      try {
        fs.renameSync(logPath, logPath + '.1');
      } catch {
        /* rotation is best-effort; keep appending to the current file */
      }
      size = 0;
    }
    try {
      fs.appendFileSync(logPath, line);
      size += bytes;
    } catch {
      /* logging must never crash the worker */
    }
  };

  return {
    logPath,
    log: write,
    info: (msg, payload) => write('info', { msg, ...payload }),
    warn: (msg, payload) => write('warn', { msg, ...payload }),
    error: (msg, payload) => write('error', { msg, ...payload }),
    tail: (n) => readLastLines(n, dir),
  };
}

/** Per-event log level (default 'info'). */
const LEVEL_BY_EVENT: Partial<Record<NodeEventName, NodeLogLevel>> = {
  [NODE_EV.JOB_ERROR]: 'error',
  [NODE_EV.HEARTBEAT_FAIL]: 'warn',
  [NODE_EV.IDLE]: 'debug',
  [NODE_EV.LEASE_RENEW]: 'debug',
  [NODE_EV.JOB_PROGRESS]: 'debug',
};

/**
 * Subscribe the logger to every NODE_EV.* event, writing one structured line
 * per event: { ts, level, ev, ...payload } (payload redacted by the logger).
 */
export function attachEngineLogging(logger: NodeLogger, engine: NodeEngine): void {
  const emitter = engine as unknown as {
    on(event: string, listener: (payload: unknown) => void): void;
  };
  for (const ev of Object.values(NODE_EV)) {
    emitter.on(ev, (payload) => {
      const fields =
        payload !== null && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : { payload };
      logger.log(LEVEL_BY_EVENT[ev] ?? 'info', { ev, ...fields });
    });
  }
}
