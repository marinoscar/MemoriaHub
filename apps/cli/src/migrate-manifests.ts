/**
 * migrate-manifests.ts — One-time importer of legacy per-folder JSON manifests.
 *
 * When the SQLite database is first opened on a machine that already has
 * manifest files under ~/.memoriahub/manifests/, this module reads every
 * manifest and upserts corresponding rows into the `folders` and `files` tables.
 *
 * Guard: the import is skipped (and never re-run) once the settings row
 * `schema_imported_manifests` is set to `true`.
 *
 * The entire operation runs inside a single transaction so it is atomic.
 * Manifest files are NOT deleted — they remain as a read-only historical record.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { loadAllManifests } from './manifest.js';
import type { FileStatus as LegacyFileStatus } from './manifest.js';

// Map legacy manifest file statuses to SQLite file statuses.
function mapStatus(
  legacy: LegacyFileStatus,
): 'uploaded' | 'failed' | 'queued' {
  switch (legacy) {
    case 'uploaded': return 'uploaded';
    case 'failed':   return 'failed';
    case 'pending':  return 'queued';
  }
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Import all legacy manifests into the SQLite database.
 *
 * Idempotent: guarded by the `schema_imported_manifests` settings flag and
 * by UNIQUE constraints (INSERT OR IGNORE) so running it twice is harmless.
 *
 * @param db  An open, migrated BetterSqlite3 database instance.
 */
export function importLegacyManifests(db: BetterSqlite3.Database): void {
  // Read the guard flag.
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('schema_imported_manifests') as { value: string } | undefined;

  let alreadyImported = false;
  try {
    alreadyImported = row ? (JSON.parse(row.value) as boolean) : false;
  } catch {
    alreadyImported = false;
  }

  if (alreadyImported) return;

  // Load all manifests from disk.
  const manifests = loadAllManifests();

  // Even if there are zero manifests, mark the flag so we don't check again.
  const doImport = db.transaction(() => {
    const insertFolder = db.prepare(
      `INSERT OR IGNORE INTO folders
         (path, path_hash, recursive, enabled, added_at, last_sync_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // 8 bound params: folder_id, file_path, sha256, status, media_item_id,
    // uploaded_at, first_seen_at, updated_at.  last_error defaults to NULL.
    const insertFile = db.prepare(
      `INSERT OR IGNORE INTO files
         (folder_id, file_path, sha256, status, media_item_id, uploaded_at,
          first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const getFolderIdByPath = db.prepare(
      'SELECT id FROM folders WHERE path = ?',
    );

    const now = new Date().toISOString();

    for (const manifest of manifests) {
      const absPath = path.resolve(manifest.folderPath);
      const pathHash = sha256Hex(absPath);

      insertFolder.run(
        absPath,
        pathHash,
        0,            // recursive = false (legacy manifests were single-folder)
        1,            // enabled = true
        now,
        manifest.lastSyncAt ?? null,
      );

      const folderRow = getFolderIdByPath.get(absPath) as { id: number } | undefined;
      if (!folderRow) continue; // should not happen

      const folderId = folderRow.id;

      for (const [filePath, entry] of Object.entries(manifest.files)) {
        const status = mapStatus(entry.status);
        insertFile.run(
          folderId,
          filePath,
          entry.sha256 ?? null,
          status,
          entry.mediaItemId ?? null,
          entry.uploadedAt ?? null,
          now,
          now,
        );
      }
    }

    // Mark as done.
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify(true),
      'schema_imported_manifests',
    );
  });

  doImport();
}
