/**
 * test/backup/verify.spec.ts — `backup verify` engine (issue #320).
 *
 * A REAL per-root SQLite catalog + REAL files in a temp dir (no mocked fs):
 * verification is pure local I/O, so faking it would test nothing.
 *
 * Covers: the standard-vs-deep hashing selection rule (needsHash), detection of
 * a BIT-FLIPPED file and a DELETED file, size drift, the catalog write-back
 * (verified_at maintained on success, status='failed' + verified_at cleared on
 * failure), the "a cheap existence check never stamps verified_at" invariant,
 * cooperative cancellation, and the exit-code policy.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo, type CatalogItem } from '../../src/backup/catalog-repo.js';
import { absPathFor } from '../../src/backup/layout.js';
import {
  VERIFY_EV,
  VerifyEmitter,
  hashFile,
  isVerifyFailure,
  needsHash,
  resolveVerifyExitCode,
  runVerify,
  selectVerifyTargets,
  verifyItem,
  type VerifyItemResult,
} from '../../src/backup/verify.js';

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

let tmpDir: string;
let root: string;
let db: BetterSqlite3.Database;
let repo: CatalogRepo;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-verify-'));
  root = path.join(tmpDir, 'backup-root');
  db = openCatalogDb(root);
  repo = new CatalogRepo(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a real file under the root and register it in the catalog. */
function seedItem(
  id: string,
  content: Buffer,
  over: Partial<Omit<CatalogItem, 'updatedAt'>> = {},
): string {
  const relPath = over.relPath ?? `media/2024/02/${id}.jpg`;
  const abs = absPathFor(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.writeFileSync(`${abs}.json`, JSON.stringify({ schemaVersion: 1, mediaItemId: id }));

  repo.upsertItemWithDims(
    {
      mediaItemId: id,
      circleId: 'circle-1',
      relPath,
      sidecarRelPath: `${relPath}.json`,
      capturedAt: '2024-02-01T10:00:00.000Z',
      contentHash: sha256(content),
      size: content.length,
      mimeType: 'image/jpeg',
      serverUpdatedAt: '2024-02-01T00:00:00.000Z',
      status: 'present',
      archived: false,
      downloadedAt: '2024-02-01T00:00:00.000Z',
      verifiedAt: '2024-02-01T00:00:00.000Z',
      lastError: null,
      ...over,
      // relPath is applied above; keep the two in sync.
      ...(over.relPath !== undefined ? { relPath: over.relPath } : {}),
    },
    {},
  );
  return relPath;
}

// ---------------------------------------------------------------------------
// needsHash — the standard-mode selection rule
// ---------------------------------------------------------------------------

describe('needsHash', () => {
  const base: CatalogItem = {
    mediaItemId: 'x',
    circleId: 'c',
    relPath: 'media/x.jpg',
    sidecarRelPath: 'media/x.jpg.json',
    capturedAt: null,
    contentHash: 'abc',
    size: 3,
    mimeType: 'image/jpeg',
    serverUpdatedAt: '2024-01-01T00:00:00.000Z',
    status: 'present',
    archived: false,
    downloadedAt: '2024-01-01T00:00:00.000Z',
    verifiedAt: '2024-01-02T00:00:00.000Z',
    lastError: null,
    updatedAt: '2024-01-02T00:00:00.000Z',
  };

  it('is false when the item was verified after it was downloaded', () => {
    expect(needsHash(base)).toBe(false);
  });

  it('is true when the item has never been verified', () => {
    expect(needsHash({ ...base, verifiedAt: null })).toBe(true);
  });

  it('is true when the item was re-downloaded since the last verify', () => {
    expect(needsHash({ ...base, downloadedAt: '2024-01-03T00:00:00.000Z' })).toBe(true);
  });

  it('is true for a previously-failed row', () => {
    expect(needsHash({ ...base, status: 'failed' })).toBe(true);
  });

  it('is true when either timestamp is unparsable', () => {
    expect(needsHash({ ...base, verifiedAt: 'garbage' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectVerifyTargets
// ---------------------------------------------------------------------------

describe('selectVerifyTargets', () => {
  it('covers present + failed rows and excludes trashed/quarantined ones', () => {
    seedItem('present-1', Buffer.from('a'));
    seedItem('failed-1', Buffer.from('b'), { status: 'failed', verifiedAt: null });
    seedItem('trashed-1', Buffer.from('c'), { status: 'trashed' });
    seedItem('quarantined-1', Buffer.from('d'), { status: 'quarantined' });

    const ids = selectVerifyTargets(repo).map((i) => i.mediaItemId);
    expect(ids).toEqual(['failed-1', 'present-1']);
  });
});

// ---------------------------------------------------------------------------
// verifyItem — per-item outcomes
// ---------------------------------------------------------------------------

describe('verifyItem', () => {
  it('detects a BIT-FLIPPED file as a hash mismatch', async () => {
    const content = Buffer.from('the original photo bytes');
    const relPath = seedItem('flip-1', content, { verifiedAt: null });

    // Flip exactly one byte — same size, so only a hash can catch it.
    const abs = absPathFor(root, relPath);
    const bytes = fs.readFileSync(abs);
    bytes[4] = bytes[4]! ^ 0xff;
    fs.writeFileSync(abs, bytes);

    const item = repo.getById('flip-1')!;
    const result = await verifyItem(root, item, false);
    expect(result.outcome).toBe('hash-mismatch');
    expect(result.hashed).toBe(true);
    expect(result.error).toMatch(/sha256/);
    expect(isVerifyFailure(result.outcome)).toBe(true);
  });

  it('detects a DELETED file as missing without hashing', async () => {
    const relPath = seedItem('gone-1', Buffer.from('bytes'));
    fs.rmSync(absPathFor(root, relPath));

    const result = await verifyItem(root, repo.getById('gone-1')!, false);
    expect(result.outcome).toBe('missing');
    expect(result.hashed).toBe(false);
  });

  it('detects size drift without hashing', async () => {
    const relPath = seedItem('size-1', Buffer.from('exactly this'));
    fs.appendFileSync(absPathFor(root, relPath), 'extra');

    const result = await verifyItem(root, repo.getById('size-1')!, false);
    expect(result.outcome).toBe('size-mismatch');
    expect(result.hashed).toBe(false);
    expect(result.error).toMatch(/does not match the catalog/);
  });

  it('standard mode does NOT hash an already-proven item', async () => {
    seedItem('proven-1', Buffer.from('proven bytes'));
    const result = await verifyItem(root, repo.getById('proven-1')!, false);
    expect(result.outcome).toBe('ok');
    expect(result.hashed).toBe(false);
  });

  it('deep mode hashes even an already-proven item', async () => {
    seedItem('proven-2', Buffer.from('proven bytes'));
    const result = await verifyItem(root, repo.getById('proven-2')!, true);
    expect(result.outcome).toBe('hashed-ok');
    expect(result.hashed).toBe(true);
  });

  it('a row with no recorded contentHash can only be size-checked', async () => {
    seedItem('nohash-1', Buffer.from('bytes'), { contentHash: null, verifiedAt: null });
    const result = await verifyItem(root, repo.getById('nohash-1')!, true);
    expect(result.outcome).toBe('ok');
    expect(result.hashed).toBe(false);
  });
});

describe('hashFile', () => {
  it('streams a file to its sha256 and byte count', async () => {
    const content = Buffer.from('some bytes to hash');
    const relPath = seedItem('h-1', content);
    const res = await hashFile(absPathFor(root, relPath));
    expect(res.sha256).toBe(sha256(content));
    expect(res.bytes).toBe(content.length);
  });
});

// ---------------------------------------------------------------------------
// runVerify — catalog write-back + summary
// ---------------------------------------------------------------------------

describe('runVerify', () => {
  it('marks a corrupted item failed and clears verified_at, leaving good ones alone', async () => {
    seedItem('good-1', Buffer.from('good bytes'), { verifiedAt: null });
    const badRel = seedItem('bad-1', Buffer.from('bad bytes!!'), { verifiedAt: null });
    const bytes = fs.readFileSync(absPathFor(root, badRel));
    bytes[0] = bytes[0]! ^ 0xff;
    fs.writeFileSync(absPathFor(root, badRel), bytes);

    const summary = await runVerify({ root }, { db });

    expect(summary.checked).toBe(2);
    expect(summary.hashed).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures.map((f) => f.mediaItemId)).toEqual(['bad-1']);

    const bad = repo.getById('bad-1')!;
    expect(bad.status).toBe('failed');
    expect(bad.verifiedAt).toBeNull();
    expect(bad.lastError).toMatch(/verify at/);

    const good = repo.getById('good-1')!;
    expect(good.status).toBe('present');
    expect(good.verifiedAt).not.toBeNull();

    // The corrupted BYTES are left on disk — verify never deletes.
    expect(fs.existsSync(absPathFor(root, badRel))).toBe(true);
  });

  it('a missing file is marked failed so the next backup run re-downloads it', async () => {
    const relPath = seedItem('missing-1', Buffer.from('bytes'));
    fs.rmSync(absPathFor(root, relPath));

    const summary = await runVerify({ root }, { db });
    expect(summary.failed).toBe(1);
    const row = repo.getById('missing-1')!;
    expect(row.status).toBe('failed');
    expect(row.verifiedAt).toBeNull();
    expect(row.lastError).toMatch(/file is missing/);
  });

  it('heals a previously-failed row whose bytes are actually fine', async () => {
    seedItem('healme-1', Buffer.from('intact bytes'), { status: 'failed', verifiedAt: null });
    const summary = await runVerify({ root }, { db });
    expect(summary.ok).toBe(1);
    const row = repo.getById('healme-1')!;
    expect(row.status).toBe('present');
    expect(row.lastError).toBeNull();
    expect(row.verifiedAt).not.toBeNull();
  });

  it('a cheap existence check never stamps verified_at', async () => {
    // Already proven, so standard mode skips hashing; verified_at must keep
    // its ORIGINAL value rather than being refreshed on an unproven basis.
    seedItem('cheap-1', Buffer.from('bytes'), { verifiedAt: '2024-02-01T00:00:00.000Z' });
    const summary = await runVerify({ root }, { db });
    expect(summary.hashed).toBe(0);
    expect(summary.ok).toBe(1);
    expect(repo.getById('cheap-1')!.verifiedAt).toBe('2024-02-01T00:00:00.000Z');
  });

  it('--deep hashes every file, including already-proven ones', async () => {
    seedItem('deep-1', Buffer.from('one'));
    seedItem('deep-2', Buffer.from('two'));
    seedItem('deep-3', Buffer.from('three'));

    const shallow = await runVerify({ root }, { db });
    expect(shallow.hashed).toBe(0);

    const deep = await runVerify({ root, deep: true }, { db });
    expect(deep.checked).toBe(3);
    expect(deep.hashed).toBe(3);
    expect(deep.deep).toBe(true);
    expect(deep.bytesHashed).toBe(3 + 3 + 5);
    expect(deep.failed).toBe(0);
  });

  it('emits started / per-item / finished events', async () => {
    seedItem('ev-1', Buffer.from('a'), { verifiedAt: null });
    seedItem('ev-2', Buffer.from('bb'), { verifiedAt: null });

    const emitter = new VerifyEmitter();
    const started: unknown[] = [];
    const items: VerifyItemResult[] = [];
    const finished: unknown[] = [];
    emitter.on(VERIFY_EV.STARTED, (p) => started.push(p));
    emitter.on(VERIFY_EV.ITEM_DONE, (p: VerifyItemResult) => items.push(p));
    emitter.on(VERIFY_EV.FINISHED, (p) => finished.push(p));

    await runVerify({ root, concurrency: 1 }, { db }, emitter);

    expect(started).toEqual([{ total: 2, deep: false, concurrency: 1 }]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.outcome === 'hashed-ok')).toBe(true);
    expect(finished).toHaveLength(1);
  });

  it('stops early when cancelled', async () => {
    for (let i = 0; i < 5; i++) seedItem(`c-${i}`, Buffer.from(`bytes-${i}`), { verifiedAt: null });

    let cancelled = false;
    const emitter = new VerifyEmitter();
    emitter.on(VERIFY_EV.ITEM_DONE, () => {
      cancelled = true;
    });

    const summary = await runVerify(
      { root, concurrency: 1 },
      { db, isCancelled: () => cancelled },
      emitter,
    );
    expect(summary.checked).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('resolveVerifyExitCode', () => {
  it('is 0 for a clean sweep and 1 when anything failed', async () => {
    seedItem('exit-ok', Buffer.from('bytes'));
    const clean = await runVerify({ root }, { db });
    expect(resolveVerifyExitCode(clean)).toBe(0);

    const relPath = seedItem('exit-bad', Buffer.from('bytes'));
    fs.rmSync(absPathFor(root, relPath));
    const dirty = await runVerify({ root }, { db });
    expect(resolveVerifyExitCode(dirty)).toBe(1);
  });
});
