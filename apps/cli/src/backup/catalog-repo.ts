/**
 * backup/catalog-repo.ts — Typed data access over the per-root backup catalog
 * (issue #314, epic #308).
 *
 * All methods are synchronous (better-sqlite3). The repo owns row<->object
 * mapping and the transactional invariants — most importantly that an item row
 * and its three dimension row-sets (tags / albums / people) are replaced in
 * ONE transaction, so a crash can never leave an item pointing at another
 * item's stale dimensions.
 *
 * No printing, no process.exit — engines and writers return typed results.
 */

import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogItemStatus = 'present' | 'trashed' | 'quarantined' | 'failed';

export interface CatalogItem {
  mediaItemId: string;
  circleId: string;
  relPath: string;
  sidecarRelPath: string;
  capturedAt: string | null;
  contentHash: string | null;
  size: number | null;
  mimeType: string | null;
  serverUpdatedAt: string;
  status: CatalogItemStatus;
  archived: boolean;
  downloadedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * The slice of the server-composed schemaVersion-1 sidecar the catalog
 * dimension tables mirror. Kept structural (not imported from the API) so the
 * CLI compiles standalone; extra sidecar fields are ignored.
 */
export interface SidecarDims {
  tags?: Array<{ name: string; source?: string | null }>;
  albums?: Array<{ id: string; name: string | null }>;
  people?: Array<{ personId: string; name: string | null }>;
}

export interface CatalogRun {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  itemsDownloaded?: number;
  itemsSkipped?: number;
  bytesDownloaded?: number;
  errorCount?: number;
  lastError?: string | null;
}

export interface CatalogStats {
  totalItems: number;
  totalBytes: number;
  byStatus: Record<CatalogItemStatus, { count: number; bytes: number }>;
  archivedCount: number;
}

interface ItemRow {
  media_item_id: string;
  circle_id: string;
  rel_path: string;
  sidecar_rel_path: string;
  captured_at: string | null;
  content_hash: string | null;
  size: number | null;
  mime_type: string | null;
  server_updated_at: string;
  status: CatalogItemStatus;
  archived: number;
  downloaded_at: string | null;
  verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function rowToItem(row: ItemRow): CatalogItem {
  return {
    mediaItemId: row.media_item_id,
    circleId: row.circle_id,
    relPath: row.rel_path,
    sidecarRelPath: row.sidecar_rel_path,
    capturedAt: row.captured_at,
    contentHash: row.content_hash,
    size: row.size,
    mimeType: row.mime_type,
    serverUpdatedAt: row.server_updated_at,
    status: row.status,
    archived: row.archived !== 0,
    downloadedAt: row.downloaded_at,
    verifiedAt: row.verified_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export class CatalogRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  // -------------------------------------------------------------------------
  // meta
  // -------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Set a meta key only if absent (e.g. created_at survives re-init). */
  setMetaIfAbsent(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // -------------------------------------------------------------------------
  // items + dimensions
  // -------------------------------------------------------------------------

  /**
   * Replace an item row AND its three dimension row-sets in ONE transaction.
   * Dims are derived from the server-composed sidecar (tags/albums/people);
   * a failure at any point rolls the whole write back, leaving the previous
   * item + dimension state intact.
   */
  upsertItemWithDims(item: Omit<CatalogItem, 'updatedAt'>, sidecar: SidecarDims): void {
    const upsert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO items (
             media_item_id, circle_id, rel_path, sidecar_rel_path,
             captured_at, content_hash, size, mime_type, server_updated_at,
             status, archived, downloaded_at, verified_at, last_error, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.mediaItemId,
          item.circleId,
          item.relPath,
          item.sidecarRelPath,
          item.capturedAt,
          item.contentHash,
          item.size,
          item.mimeType,
          item.serverUpdatedAt,
          item.status,
          item.archived ? 1 : 0,
          item.downloadedAt,
          item.verifiedAt,
          item.lastError,
          new Date().toISOString(),
        );

      for (const table of ['item_tags', 'item_albums', 'item_people']) {
        this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(item.mediaItemId);
      }

      const insertTag = this.db.prepare(
        'INSERT OR IGNORE INTO item_tags (media_item_id, tag, source) VALUES (?, ?, ?)',
      );
      for (const tag of sidecar.tags ?? []) {
        insertTag.run(item.mediaItemId, tag.name, tag.source ?? null);
      }

      const insertAlbum = this.db.prepare(
        'INSERT OR IGNORE INTO item_albums (media_item_id, album_id, album_name) VALUES (?, ?, ?)',
      );
      for (const album of sidecar.albums ?? []) {
        insertAlbum.run(item.mediaItemId, album.id, album.name);
      }

      const insertPerson = this.db.prepare(
        'INSERT OR IGNORE INTO item_people (media_item_id, person_id, person_name) VALUES (?, ?, ?)',
      );
      for (const person of sidecar.people ?? []) {
        insertPerson.run(item.mediaItemId, person.personId, person.name);
      }
    });

    upsert();
  }

  getById(mediaItemId: string): CatalogItem | null {
    const row = this.db
      .prepare<[string], ItemRow>('SELECT * FROM items WHERE media_item_id = ?')
      .get(mediaItemId);
    return row ? rowToItem(row) : null;
  }

  getByPath(relPath: string): CatalogItem | null {
    const row = this.db
      .prepare<[string], ItemRow>('SELECT * FROM items WHERE rel_path = ?')
      .get(relPath);
    return row ? rowToItem(row) : null;
  }

  /** The mediaItemId claiming a rel_path, or null — the layout collision lookup. */
  ownerOfPath(relPath: string): string | null {
    const row = this.db
      .prepare<[string], { media_item_id: string }>(
        'SELECT media_item_id FROM items WHERE rel_path = ?',
      )
      .get(relPath);
    return row?.media_item_id ?? null;
  }

  listByStatus(status: CatalogItemStatus, limit?: number): CatalogItem[] {
    const sql =
      'SELECT * FROM items WHERE status = ? ORDER BY media_item_id' +
      (limit !== undefined ? ' LIMIT ?' : '');
    const stmt = this.db.prepare<unknown[], ItemRow>(sql);
    const rows = limit !== undefined ? stmt.all(status, limit) : stmt.all(status);
    return rows.map(rowToItem);
  }

  /** Iterate every media_item_id (for the later reconcile pass) without buffering rows. */
  *allIds(): IterableIterator<string> {
    const stmt = this.db.prepare<[], { media_item_id: string }>(
      'SELECT media_item_id FROM items ORDER BY media_item_id',
    );
    for (const row of stmt.iterate()) {
      yield row.media_item_id;
    }
  }

  setStatus(mediaItemId: string, status: CatalogItemStatus, lastError?: string | null): void {
    this.db
      .prepare(
        'UPDATE items SET status = ?, last_error = ?, updated_at = ? WHERE media_item_id = ?',
      )
      .run(status, lastError ?? null, new Date().toISOString(), mediaItemId);
  }

  /** Update the stored rel_path (+ sidecar path) after an archive/unarchive move. */
  setRelPath(mediaItemId: string, relPath: string, sidecarRelPath: string): void {
    this.db
      .prepare(
        'UPDATE items SET rel_path = ?, sidecar_rel_path = ?, updated_at = ? WHERE media_item_id = ?',
      )
      .run(relPath, sidecarRelPath, new Date().toISOString(), mediaItemId);
  }

  // -------------------------------------------------------------------------
  // runs
  // -------------------------------------------------------------------------

  recordRun(run: CatalogRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (
           id, kind, status, started_at, finished_at,
           items_downloaded, items_skipped, bytes_downloaded, error_count, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.kind,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        run.itemsDownloaded ?? 0,
        run.itemsSkipped ?? 0,
        run.bytesDownloaded ?? 0,
        run.errorCount ?? 0,
        run.lastError ?? null,
      );
  }

  // -------------------------------------------------------------------------
  // checkpoint (mirrored server cursor — offline cache)
  // -------------------------------------------------------------------------

  getCheckpoint(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string | null }>('SELECT value FROM checkpoint WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }

  setCheckpoint(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO checkpoint (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // stats (for `backup status`)
  // -------------------------------------------------------------------------

  stats(): CatalogStats {
    const rows = this.db
      .prepare<[], { status: CatalogItemStatus; count: number; bytes: number | null }>(
        'SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM items GROUP BY status',
      )
      .all();

    const byStatus: CatalogStats['byStatus'] = {
      present: { count: 0, bytes: 0 },
      trashed: { count: 0, bytes: 0 },
      quarantined: { count: 0, bytes: 0 },
      failed: { count: 0, bytes: 0 },
    };
    let totalItems = 0;
    let totalBytes = 0;
    for (const row of rows) {
      byStatus[row.status] = { count: row.count, bytes: row.bytes ?? 0 };
      totalItems += row.count;
      totalBytes += row.bytes ?? 0;
    }

    const archivedRow = this.db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM items WHERE archived = 1')
      .get();

    return { totalItems, totalBytes, byStatus, archivedCount: archivedRow?.count ?? 0 };
  }
}
