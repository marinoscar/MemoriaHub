/**
 * paths.ts — Centralized filesystem path helpers for MemoriaHub CLI.
 *
 * All paths under ~/.memoriahub are derived from here so that every module
 * can import a single source of truth instead of duplicating os.homedir() calls.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Root config/data directory: ~/.memoriahub by default.
 *
 * `MEMORIAHUB_STATE_DIR` (absolute path) relocates the whole state tree —
 * config.json, SQLite db, pidfile, IPC socket, logs, and models all derive
 * from this base — so containers can mount a single writable volume without
 * needing a writable home directory.
 */
export function configDir(): string {
  const override = process.env['MEMORIAHUB_STATE_DIR']?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.memoriahub');
}

/** SQLite database file: ~/.memoriahub/memoriahub.db */
export function dbPath(): string {
  return path.join(configDir(), 'memoriahub.db');
}

/** Legacy per-folder manifest directory: ~/.memoriahub/manifests/ */
export function manifestsDir(): string {
  return path.join(configDir(), 'manifests');
}

/** Scan Excel/CSV export directory: ~/.memoriahub/exports/ */
export function exportsDir(): string {
  return path.join(configDir(), 'exports');
}

/** Worker-node model download directory: ~/.memoriahub/models/ */
export function modelsDir(): string {
  return path.join(configDir(), 'models');
}

/** Worker-node log directory: ~/.memoriahub/logs/ (created on demand). */
export function logsDir(): string {
  const dir = path.join(configDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Runtime-state directory for the worker-node daemon's pidfile and IPC socket:
 * ~/.memoriahub (created on demand).
 */
export function runDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Worker-node daemon pidfile: ~/.memoriahub/node.pid */
export function nodePidPath(): string {
  return path.join(runDir(), 'node.pid');
}

/**
 * Worker-node daemon IPC endpoint.
 *
 * Linux/macOS/WSL: a unix domain socket at ~/.memoriahub/node.sock.
 * Windows: the named pipe \\.\pipe\memoriahub-node (named pipes are not
 * filesystem paths — no unlink/chmod applies there).
 */
export function nodeSocketPath(): string {
  if (os.platform() === 'win32') {
    return '\\\\.\\pipe\\memoriahub-node';
  }
  return path.join(runDir(), 'node.sock');
}
