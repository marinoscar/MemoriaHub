/**
 * reset.ts — Factory-reset helper for MemoriaHub CLI.
 *
 * Removes all local CLI state:
 *   - config.json  (server URL + PAT)
 *   - memoriahub.db + WAL/SHM sidecars  (upload history, sync runs, settings)
 *   - manifests/   (legacy per-folder manifests)
 *
 * The ~/.memoriahub/ directory itself is NOT removed; it is recreated on the
 * next command that needs it.
 *
 * Call closeDb() FIRST so WAL pages are flushed before file deletion.
 */

import * as fs from 'fs';
import { closeDb } from './db/database.js';
import { configPath } from './config.js';
import { dbPath, manifestsDir } from './paths.js';

/**
 * Perform a factory reset of all local CLI state.
 *
 * 1. Closes the SQLite handle (flushes WAL) before touching files.
 * 2. Deletes config.json, memoriahub.db (+ -wal, -shm), and manifests/.
 * 3. Returns the list of paths that actually existed and were removed.
 *
 * Missing paths are silently ignored — this function never throws.
 */
export function factoryReset(): { removed: string[] } {
  // Flush WAL and release the file handle before attempting deletion.
  closeDb();

  const removed: string[] = [];

  // Individual files to delete.
  const files = [
    configPath(),
    dbPath(),
    dbPath() + '-wal',
    dbPath() + '-shm',
  ];

  for (const p of files) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      removed.push(p);
    }
  }

  // Directories to delete recursively.
  const dirs = [manifestsDir()];

  for (const p of dirs) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  }

  return { removed };
}
