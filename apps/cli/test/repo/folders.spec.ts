/**
 * test/repo/folders.spec.ts
 *
 * Unit tests for FolderRepo — uses an in-memory SQLite database so no files
 * under ~/.memoriahub are touched and no migrations need real disk paths.
 */

import * as path from 'path';
import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import type BetterSqlite3 from 'better-sqlite3';

// Helpers
function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

describe('FolderRepo', () => {
  let db: BetterSqlite3.Database;
  let repo: FolderRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new FolderRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------------

  describe('add', () => {
    it('inserts a folder and returns it with resolved absolute path', () => {
      const folder = repo.add({ path: '/tmp/photos' });
      expect(folder.id).toBeGreaterThan(0);
      expect(folder.path).toBe(path.resolve('/tmp/photos'));
      expect(folder.enabled).toBe(true);
      expect(folder.recursive).toBe(false);
      expect(folder.last_sync_at).toBeNull();
    });

    it('stores path_hash as a 64-char hex string', () => {
      const folder = repo.add({ path: '/tmp/photos' });
      expect(folder.path_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('respects recursive=true option', () => {
      const folder = repo.add({ path: '/tmp/a', recursive: true });
      expect(folder.recursive).toBe(true);
    });

    it('respects enabled=false option', () => {
      const folder = repo.add({ path: '/tmp/b', enabled: false });
      expect(folder.enabled).toBe(false);
    });

    it('throws on duplicate path', () => {
      repo.add({ path: '/tmp/dup' });
      expect(() => repo.add({ path: '/tmp/dup' })).toThrow(/already registered/i);
    });

    it('resolves relative paths to absolute', () => {
      const folder = repo.add({ path: '.' });
      expect(path.isAbsolute(folder.path)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('returns empty array when no folders exist', () => {
      expect(repo.list()).toEqual([]);
    });

    it('returns all folders when enabledOnly is omitted', () => {
      repo.add({ path: '/tmp/a' });
      repo.add({ path: '/tmp/b', enabled: false });
      const all = repo.list();
      expect(all).toHaveLength(2);
    });

    it('returns only enabled folders when enabledOnly=true', () => {
      repo.add({ path: '/tmp/c' });
      repo.add({ path: '/tmp/d', enabled: false });
      const enabled = repo.list({ enabledOnly: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].path).toBe(path.resolve('/tmp/c'));
    });

    it('orders folders by id (insertion order)', () => {
      repo.add({ path: '/tmp/first' });
      repo.add({ path: '/tmp/second' });
      const all = repo.list();
      expect(all[0].path).toBe(path.resolve('/tmp/first'));
      expect(all[1].path).toBe(path.resolve('/tmp/second'));
    });
  });

  // ---------------------------------------------------------------------------
  // getById
  // ---------------------------------------------------------------------------

  describe('getById', () => {
    it('returns the folder for a known id', () => {
      const inserted = repo.add({ path: '/tmp/byid' });
      const found = repo.getById(inserted.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
    });

    it('returns null for an unknown id', () => {
      expect(repo.getById(9999)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getByPath
  // ---------------------------------------------------------------------------

  describe('getByPath', () => {
    it('returns the folder for a known path', () => {
      repo.add({ path: '/tmp/bypath' });
      const found = repo.getByPath('/tmp/bypath');
      expect(found).not.toBeNull();
      expect(found!.path).toBe(path.resolve('/tmp/bypath'));
    });

    it('returns null for an unknown path', () => {
      expect(repo.getByPath('/tmp/no-such-folder')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // resolve
  // ---------------------------------------------------------------------------

  describe('resolve', () => {
    it('resolves by numeric id (number type)', () => {
      const inserted = repo.add({ path: '/tmp/res1' });
      expect(repo.resolve(inserted.id)).not.toBeNull();
    });

    it('resolves by numeric id passed as a string', () => {
      const inserted = repo.add({ path: '/tmp/res2' });
      const found = repo.resolve(String(inserted.id));
      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
    });

    it('resolves by path string', () => {
      repo.add({ path: '/tmp/res3' });
      expect(repo.resolve('/tmp/res3')).not.toBeNull();
    });

    it('returns null for an unknown id or path', () => {
      expect(repo.resolve(9999)).toBeNull();
      expect(repo.resolve('/no/such/path')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setEnabled
  // ---------------------------------------------------------------------------

  describe('setEnabled', () => {
    it('disables a folder', () => {
      const inserted = repo.add({ path: '/tmp/en1' });
      const updated = repo.setEnabled(inserted.id, false);
      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(false);
    });

    it('re-enables a disabled folder', () => {
      const inserted = repo.add({ path: '/tmp/en2', enabled: false });
      const updated = repo.setEnabled(inserted.id, true);
      expect(updated!.enabled).toBe(true);
    });

    it('returns null for unknown id', () => {
      expect(repo.setEnabled(9999, true)).toBeNull();
    });

    it('also accepts path string', () => {
      repo.add({ path: '/tmp/en3' });
      const updated = repo.setEnabled('/tmp/en3', false);
      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // setRecursive
  // ---------------------------------------------------------------------------

  describe('setRecursive', () => {
    it('enables recursive on a non-recursive folder', () => {
      const inserted = repo.add({ path: '/tmp/rec1' });
      const updated = repo.setRecursive(inserted.id, true);
      expect(updated!.recursive).toBe(true);
    });

    it('disables recursive on a recursive folder', () => {
      const inserted = repo.add({ path: '/tmp/rec2', recursive: true });
      const updated = repo.setRecursive(inserted.id, false);
      expect(updated!.recursive).toBe(false);
    });

    it('returns null for unknown id', () => {
      expect(repo.setRecursive(9999, true)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // touchLastSync
  // ---------------------------------------------------------------------------

  describe('touchLastSync', () => {
    it('updates last_sync_at for an existing folder', () => {
      const inserted = repo.add({ path: '/tmp/sync1' });
      expect(inserted.last_sync_at).toBeNull();

      const iso = new Date().toISOString();
      repo.touchLastSync(inserted.id, iso);

      const updated = repo.getById(inserted.id);
      expect(updated!.last_sync_at).toBe(iso);
    });
  });

  // ---------------------------------------------------------------------------
  // remove (cascade)
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('returns true and deletes the folder', () => {
      const inserted = repo.add({ path: '/tmp/del1' });
      const result = repo.remove(inserted.id);
      expect(result).toBe(true);
      expect(repo.getById(inserted.id)).toBeNull();
    });

    it('returns false for an unknown folder', () => {
      expect(repo.remove(9999)).toBe(false);
    });

    it('cascades to delete child files', () => {
      const inserted = repo.add({ path: '/tmp/cas1' });
      const fileRepo = new FileRepo(db);
      fileRepo.upsert(inserted.id, '/tmp/cas1/photo.jpg', { status: 'queued' });

      // Verify file exists
      const before = fileRepo.listByFolder(inserted.id);
      expect(before).toHaveLength(1);

      // Remove the folder
      repo.remove(inserted.id);

      // File should be gone (ON DELETE CASCADE)
      const after = fileRepo.listByFolder(inserted.id);
      expect(after).toHaveLength(0);
    });

    it('accepts path string for removal', () => {
      repo.add({ path: '/tmp/del2' });
      const result = repo.remove('/tmp/del2');
      expect(result).toBe(true);
      expect(repo.getByPath('/tmp/del2')).toBeNull();
    });
  });
});
