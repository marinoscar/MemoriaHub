/**
 * paths.ts — Centralized filesystem path helpers for MemoriaHub CLI.
 *
 * All paths under ~/.memoriahub are derived from here so that every module
 * can import a single source of truth instead of duplicating os.homedir() calls.
 */

import * as os from 'os';
import * as path from 'path';

/** Root config/data directory: ~/.memoriahub */
export function configDir(): string {
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
