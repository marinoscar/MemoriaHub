/**
 * test/repo/files.spec.ts
 *
 * Unit tests for FileRepo — all operations against an in-memory SQLite DB.
 */

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

/** Create a folder so we have a valid folder_id foreign key. */
function seedFolder(db: BetterSqlite3.Database, folderPath = '/tmp/testfolder'): number {
  const repo = new FolderRepo(db);
  return repo.add({ path: folderPath }).id;
}

describe('FileRepo', () => {
  let db: BetterSqlite3.Database;
  let repo: FileRepo;
  let folderId: number;

  beforeEach(() => {
    db = makeDb();
    repo = new FileRepo(db);
    folderId = seedFolder(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // upsert
  // ---------------------------------------------------------------------------

  describe('upsert', () => {
    it('inserts a new file record with default status=queued', () => {
      const rec = repo.upsert(folderId, '/tmp/testfolder/photo.jpg');
      expect(rec.id).toBeGreaterThan(0);
      expect(rec.folder_id).toBe(folderId);
      expect(rec.file_path).toBe('/tmp/testfolder/photo.jpg');
      expect(rec.status).toBe('queued');
      expect(rec.attempt_count).toBe(0);
      expect(rec.sha256).toBeNull();
    });

    it('inserts with supplied fields', () => {
      const rec = repo.upsert(folderId, '/tmp/testfolder/a.jpg', {
        sha256: 'abc123',
        status: 'uploaded',
        size_bytes: 1024,
        mime_type: 'image/jpeg',
      });
      expect(rec.sha256).toBe('abc123');
      expect(rec.status).toBe('uploaded');
      expect(rec.size_bytes).toBe(1024);
      expect(rec.mime_type).toBe('image/jpeg');
    });

    it('updates existing record on duplicate (folder_id, file_path)', () => {
      // First upsert — inserts
      repo.upsert(folderId, '/tmp/testfolder/b.jpg');

      // Second upsert with new sha256 — should UPDATE not INSERT
      const updated = repo.upsert(folderId, '/tmp/testfolder/b.jpg', { sha256: 'deadbeef' });

      // There should be exactly one row
      const all = repo.listByFolder(folderId);
      expect(all).toHaveLength(1);

      expect(updated.sha256).toBe('deadbeef');
    });

    it('upsert on different paths produces distinct rows', () => {
      repo.upsert(folderId, '/tmp/testfolder/c.jpg');
      repo.upsert(folderId, '/tmp/testfolder/d.jpg');
      const all = repo.listByFolder(folderId);
      expect(all).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // setStatus
  // ---------------------------------------------------------------------------

  describe('setStatus', () => {
    it('changes status from queued to uploading', () => {
      const rec = repo.upsert(folderId, '/tmp/f1.jpg');
      repo.setStatus(rec.id, 'uploading');
      const after = repo.getByFolderAndPath(folderId, '/tmp/f1.jpg');
      expect(after!.status).toBe('uploading');
    });

    it('transitions from uploading to uploaded with patch fields', () => {
      const rec = repo.upsert(folderId, '/tmp/f2.jpg');
      repo.setStatus(rec.id, 'uploading');
      repo.setStatus(rec.id, 'uploaded', {
        sha256: 'aabbcc',
        media_item_id: 'media-1',
        storage_object_id: 'obj-1',
        uploaded_at: new Date().toISOString(),
      });
      const after = repo.getByFolderAndPath(folderId, '/tmp/f2.jpg');
      expect(after!.status).toBe('uploaded');
      expect(after!.sha256).toBe('aabbcc');
      expect(after!.media_item_id).toBe('media-1');
      expect(after!.storage_object_id).toBe('obj-1');
      expect(after!.uploaded_at).not.toBeNull();
    });

    it('transitions to failed status', () => {
      const rec = repo.upsert(folderId, '/tmp/f3.jpg');
      repo.setStatus(rec.id, 'failed');
      const after = repo.getByFolderAndPath(folderId, '/tmp/f3.jpg');
      expect(after!.status).toBe('failed');
    });

    it('transitions to skipped with dedup metadata', () => {
      const rec = repo.upsert(folderId, '/tmp/f4.jpg');
      repo.setStatus(rec.id, 'skipped', { media_item_id: 'dedup-media' });
      const after = repo.getByFolderAndPath(folderId, '/tmp/f4.jpg');
      expect(after!.status).toBe('skipped');
      expect(after!.media_item_id).toBe('dedup-media');
    });

    it('allows resetting attempt_count via patch', () => {
      const rec = repo.upsert(folderId, '/tmp/f5.jpg');
      repo.incrementAttempt(rec.id);
      repo.incrementAttempt(rec.id);
      repo.setStatus(rec.id, 'queued', { attempt_count: 0 });
      const after = repo.getByFolderAndPath(folderId, '/tmp/f5.jpg');
      expect(after!.attempt_count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // incrementAttempt
  // ---------------------------------------------------------------------------

  describe('incrementAttempt', () => {
    it('increments attempt_count by 1', () => {
      const rec = repo.upsert(folderId, '/tmp/ia1.jpg');
      repo.incrementAttempt(rec.id);
      const after = repo.getByFolderAndPath(folderId, '/tmp/ia1.jpg');
      expect(after!.attempt_count).toBe(1);
    });

    it('accumulates across multiple calls', () => {
      const rec = repo.upsert(folderId, '/tmp/ia2.jpg');
      repo.incrementAttempt(rec.id);
      repo.incrementAttempt(rec.id);
      repo.incrementAttempt(rec.id);
      const after = repo.getByFolderAndPath(folderId, '/tmp/ia2.jpg');
      expect(after!.attempt_count).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // setError
  // ---------------------------------------------------------------------------

  describe('setError', () => {
    it('stores the error message in last_error', () => {
      const rec = repo.upsert(folderId, '/tmp/err1.jpg');
      repo.setError(rec.id, 'Network timeout');
      const after = repo.getByFolderAndPath(folderId, '/tmp/err1.jpg');
      expect(after!.last_error).toBe('Network timeout');
    });
  });

  // ---------------------------------------------------------------------------
  // getByFolderAndPath
  // ---------------------------------------------------------------------------

  describe('getByFolderAndPath', () => {
    it('returns the record when it exists', () => {
      repo.upsert(folderId, '/tmp/gbp1.jpg');
      const rec = repo.getByFolderAndPath(folderId, '/tmp/gbp1.jpg');
      expect(rec).not.toBeNull();
    });

    it('returns null when the record does not exist', () => {
      expect(repo.getByFolderAndPath(folderId, '/no/such/file.jpg')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listByFolder
  // ---------------------------------------------------------------------------

  describe('listByFolder', () => {
    it('returns all files for a folder when status is omitted', () => {
      repo.upsert(folderId, '/tmp/lbf1.jpg');
      repo.upsert(folderId, '/tmp/lbf2.jpg');
      const all = repo.listByFolder(folderId);
      expect(all).toHaveLength(2);
    });

    it('filters by status', () => {
      const r1 = repo.upsert(folderId, '/tmp/lbf3.jpg');
      const r2 = repo.upsert(folderId, '/tmp/lbf4.jpg');
      repo.setStatus(r1.id, 'uploading');
      // r2 stays queued

      const uploading = repo.listByFolder(folderId, { status: 'uploading' });
      expect(uploading).toHaveLength(1);
      expect(uploading[0].file_path).toBe('/tmp/lbf3.jpg');

      const queued = repo.listByFolder(folderId, { status: 'queued' });
      expect(queued).toHaveLength(1);
      expect(queued[0].file_path).toBe('/tmp/lbf4.jpg');
    });

    it('returns empty array when folder has no files', () => {
      expect(repo.listByFolder(folderId)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listFailed — attempt_count < cap
  // ---------------------------------------------------------------------------

  describe('listFailed', () => {
    it('returns failed files below attempt cap', () => {
      const r1 = repo.upsert(folderId, '/tmp/lf1.jpg');
      repo.setStatus(r1.id, 'failed');
      repo.incrementAttempt(r1.id); // attempt_count = 1

      const failed = repo.listFailed({ cap: 5 });
      expect(failed).toHaveLength(1);
      expect(failed[0].file_path).toBe('/tmp/lf1.jpg');
    });

    it('excludes files at or above cap', () => {
      const r1 = repo.upsert(folderId, '/tmp/lf2.jpg');
      repo.setStatus(r1.id, 'failed');
      // Manually set attempt_count to cap
      repo.setStatus(r1.id, 'failed', { attempt_count: 5 });

      const failed = repo.listFailed({ cap: 5 });
      expect(failed).toHaveLength(0);
    });

    it('scopes to specific folderIds when provided', () => {
      const folder2 = seedFolder(db, '/tmp/testfolder2');

      const r1 = repo.upsert(folderId, '/tmp/lf3.jpg');
      repo.setStatus(r1.id, 'failed');

      const r2 = repo.upsert(folder2, '/tmp/lf4.jpg');
      repo.setStatus(r2.id, 'failed');

      const failedInFolder1 = repo.listFailed({ folderIds: [folderId], cap: 5 });
      expect(failedInFolder1).toHaveLength(1);
      expect(failedInFolder1[0].folder_id).toBe(folderId);
    });

    it('returns empty when no failed files', () => {
      repo.upsert(folderId, '/tmp/lf5.jpg'); // queued
      expect(repo.listFailed()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listBlocked — attempt_count >= cap
  // ---------------------------------------------------------------------------

  describe('listBlocked', () => {
    it('returns failed files at or above cap', () => {
      const r1 = repo.upsert(folderId, '/tmp/lb1.jpg');
      repo.setStatus(r1.id, 'failed', { attempt_count: 5 });

      const blocked = repo.listBlocked({ cap: 5 });
      expect(blocked).toHaveLength(1);
    });

    it('excludes files below cap', () => {
      const r1 = repo.upsert(folderId, '/tmp/lb2.jpg');
      repo.setStatus(r1.id, 'failed');
      repo.incrementAttempt(r1.id); // attempt_count = 1

      const blocked = repo.listBlocked({ cap: 5 });
      expect(blocked).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // counts — aggregation
  // ---------------------------------------------------------------------------

  describe('counts', () => {
    it('returns zeroes for an empty folder', () => {
      const c = repo.counts([folderId]);
      expect(c).toEqual({ queued: 0, uploading: 0, uploaded: 0, skipped: 0, failed: 0, total: 0 });
    });

    it('aggregates all statuses correctly', () => {
      const r1 = repo.upsert(folderId, '/tmp/cnt1.jpg'); // queued
      const r2 = repo.upsert(folderId, '/tmp/cnt2.jpg');
      const r3 = repo.upsert(folderId, '/tmp/cnt3.jpg');
      const r4 = repo.upsert(folderId, '/tmp/cnt4.jpg');
      const r5 = repo.upsert(folderId, '/tmp/cnt5.jpg');

      repo.setStatus(r2.id, 'uploading');
      repo.setStatus(r3.id, 'uploaded');
      repo.setStatus(r4.id, 'skipped');
      repo.setStatus(r5.id, 'failed');

      const c = repo.counts([folderId]);
      expect(c.queued).toBe(1);
      expect(c.uploading).toBe(1);
      expect(c.uploaded).toBe(1);
      expect(c.skipped).toBe(1);
      expect(c.failed).toBe(1);
      expect(c.total).toBe(5);
    });

    it('counts across all folders when folderIds is empty', () => {
      const folder2 = seedFolder(db, '/tmp/folder2');
      repo.upsert(folderId, '/tmp/cnt6.jpg');
      repo.upsert(folder2, '/tmp/cnt7.jpg');
      const c = repo.counts();
      expect(c.total).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // resetStaleUploading
  // ---------------------------------------------------------------------------

  describe('resetStaleUploading', () => {
    it('resets uploading→queued and returns count of changed rows', () => {
      const r1 = repo.upsert(folderId, '/tmp/stale1.jpg');
      const r2 = repo.upsert(folderId, '/tmp/stale2.jpg');
      repo.setStatus(r1.id, 'uploading');
      repo.setStatus(r2.id, 'uploading');

      const changed = repo.resetStaleUploading([folderId]);
      expect(changed).toBe(2);

      const all = repo.listByFolder(folderId);
      for (const rec of all) {
        expect(rec.status).toBe('queued');
      }
    });

    it('leaves non-uploading statuses untouched', () => {
      const r1 = repo.upsert(folderId, '/tmp/stale3.jpg');
      repo.setStatus(r1.id, 'uploaded');

      const changed = repo.resetStaleUploading([folderId]);
      expect(changed).toBe(0);

      const rec = repo.getByFolderAndPath(folderId, '/tmp/stale3.jpg');
      expect(rec!.status).toBe('uploaded');
    });

    it('scopes to provided folderIds', () => {
      const folder2 = seedFolder(db, '/tmp/stale-folder2');
      const r1 = repo.upsert(folderId, '/tmp/stale4.jpg');
      const r2 = repo.upsert(folder2, '/tmp/stale5.jpg');
      repo.setStatus(r1.id, 'uploading');
      repo.setStatus(r2.id, 'uploading');

      // Reset only folder2
      const changed = repo.resetStaleUploading([folder2]);
      expect(changed).toBe(1);

      // folder1 file still uploading
      const rec1 = repo.getByFolderAndPath(folderId, '/tmp/stale4.jpg');
      expect(rec1!.status).toBe('uploading');
    });

    it('returns 0 when nothing is uploading', () => {
      expect(repo.resetStaleUploading()).toBe(0);
    });
  });
});
