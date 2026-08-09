/**
 * test/backup/reconcile.spec.ts — Reconcile runs (issue #320).
 *
 * Mocked ApiClient slice + a REAL per-root SQLite catalog in a temp dir, same
 * harness style as backup-engine.spec.ts. Covers:
 *   - a hard-deleted (manifest-absent) item ends up in _quarantine/ WITH its
 *     sidecar, status='quarantined', and its bytes are never unlinked;
 *   - manifest streaming across multiple id-keyset pages through the temp
 *     reconcile_ids table, which is dropped afterwards;
 *   - a cancelled stream applies NO diff (nothing quarantined);
 *   - contentHash drift marks the row for re-download, and the FOLLOWING
 *     incremental pass actually re-downloads it end to end;
 *   - the 30-day auto-upgrade decision (shouldAutoReconcile / resolveRunKind).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  BackupAckBody,
  BackupChangeItem,
  BackupChangesPage,
  BackupManifestItem,
  FinishBackupRunBody,
  GetRawOptions,
  GetRawResult,
  NodeBackupConfigResult,
} from '../../src/api.js';
import { BackupEngine, type BackupApi } from '../../src/backup/backup-engine.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { absPathFor, QUARANTINE_DIR } from '../../src/backup/layout.js';
import {
  RECONCILE_EVERY_DAYS,
  performReconcile,
  quarantineRelPathFor,
  resolveRunKind,
  shouldAutoReconcile,
} from '../../src/backup/reconcile.js';

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;

function feedItem(over: Partial<BackupChangeItem> & { id: string }): BackupChangeItem {
  seq++;
  const updatedAt = `2024-02-01T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`;
  return {
    circleId: 'circle-1',
    updatedAt,
    createdAt: '2024-01-01T00:00:00.000Z',
    capturedAt: '2024-02-01T10:00:00.000Z',
    capturedAtOffset: 0,
    type: 'photo',
    deletedAt: null,
    archivedAt: null,
    contentHash: null,
    originalFilename: `${over.id}.jpg`,
    storage: { objectId: `obj-${over.id}`, size: '0', mimeType: 'image/jpeg', status: 'ready' },
    downloadUrl: `https://s3.test/${over.id}`,
    downloadUrlExpiresAt: null,
    sidecar: { schemaVersion: 1, mediaItemId: over.id, tags: [], albums: [], people: [] },
    ...over,
  };
}

function withContent(
  item: BackupChangeItem,
  contents: Map<string, Buffer>,
  content: Buffer,
): BackupChangeItem {
  contents.set(item.downloadUrl as string, content);
  return {
    ...item,
    contentHash: sha256(content),
    storage: {
      ...(item.storage as NonNullable<BackupChangeItem['storage']>),
      size: String(content.length),
    },
  };
}

/**
 * Build the pages ONE run will walk, in order. The fake serves them as a queue
 * rather than keying on the cursor: the engine resumes from its mirrored local
 * checkpoint across runs, so a cursor-keyed map would silently serve an empty
 * page on every run after the first.
 */
function chainPages(pageItems: BackupChangeItem[][]): BackupChangesPage[] {
  return pageItems.map((items, i) => {
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
      hasMore: i < pageItems.length - 1,
      safetyHorizon: '2024-02-01T23:00:00.000Z',
    };
  });
}

const EMPTY_PAGE: BackupChangesPage = {
  items: [],
  nextCursor: null,
  hasMore: false,
  safetyHorizon: '2024-02-01T23:00:00.000Z',
};

interface FakeApi {
  api: BackupApi;
  acks: BackupAckBody[];
  finishes: Array<{ runId: string; body: FinishBackupRunBody }>;
  manifestCalls: Array<string | null>;
  getRawCalls: Map<string, number>;
  /** Mutable: tests reassign between runs. */
  state: { pages: BackupChangesPage[]; manifest: BackupManifestItem[] };
}

function makeApi(
  pages: BackupChangesPage[],
  contents: Map<string, Buffer>,
  manifest: BackupManifestItem[] = [],
  opts: { manifestPageSize?: number } = {},
): FakeApi {
  const acks: BackupAckBody[] = [];
  const finishes: Array<{ runId: string; body: FinishBackupRunBody }> = [];
  const manifestCalls: Array<string | null> = [];
  const getRawCalls = new Map<string, number>();
  const state = { pages, manifest };
  let runCounter = 0;

  const api: BackupApi = {
    startNodeBackupRun: (async (_nodeId: string, body: { kind: string }) => ({
      run: {
        id: `run-${++runCounter}`,
        kind: body.kind,
        startedAt: '2024-02-01T00:00:00.000Z',
        cursorStart: { updatedAt: null, id: null },
      },
    })) as BackupApi['startNodeBackupRun'],

    getNodeBackupChanges: (async () => state.pages.shift() ?? EMPTY_PAGE) as BackupApi['getNodeBackupChanges'],

    ackNodeBackup: (async (_nodeId: string, body: BackupAckBody) => {
      acks.push(body);
      return { ok: true as const, checkpoint: body.cursor };
    }) as BackupApi['ackNodeBackup'],

    finishNodeBackupRun: (async (_nodeId: string, runId: string, body: FinishBackupRunBody) => {
      finishes.push({ runId, body });
      return { ok: true as const };
    }) as BackupApi['finishNodeBackupRun'],

    getNodeBackupDimensions: (async () => ({
      albums: [],
      people: [],
      tags: [],
      generatedAt: '2024-02-01T02:00:00.000Z',
    })) as BackupApi['getNodeBackupDimensions'],

    getNodeBackupManifest: (async (_nodeId: string, q: { afterId?: string; limit?: number }) => {
      const all = [...state.manifest].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limit = opts.manifestPageSize ?? q.limit ?? 1000;
      const startIdx = q.afterId === undefined ? 0 : all.findIndex((r) => r.id === q.afterId) + 1;
      const slice = all.slice(startIdx, startIdx + limit);
      manifestCalls.push(q.afterId ?? null);
      return {
        items: slice,
        nextAfterId: slice.length > 0 ? slice[slice.length - 1]!.id : null,
        hasMore: startIdx + slice.length < all.length,
      };
    }) as BackupApi['getNodeBackupManifest'],

    getRaw: (async (url: string, destPath: string, o?: GetRawOptions): Promise<GetRawResult> => {
      getRawCalls.set(url, (getRawCalls.get(url) ?? 0) + 1);
      const cfg = (await o?.attempt?.()) ?? {};
      const content = contents.get(url);
      if (!content) throw new Error(`no content registered for ${url}`);
      await cfg.onResponse?.({ status: 200, resumed: false });
      await cfg.onChunk?.(Buffer.from(content));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
      return { status: 200, bytesWritten: content.length };
    }) as BackupApi['getRaw'],
  };

  return { api, acks, finishes, manifestCalls, getRawCalls, state };
}

/** Build a manifest row from a feed item (the server's view of it). */
function manifestRow(item: BackupChangeItem): BackupManifestItem {
  return {
    id: item.id,
    contentHash: item.contentHash,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
    archivedAt: item.archivedAt,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let root: string;
const openDbs: BetterSqlite3.Database[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-reconcile-'));
  root = path.join(tmpDir, 'backup-root');
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(
  api: BackupApi,
  kind: 'incremental' | 'reconcile',
  db?: BetterSqlite3.Database,
): { engine: BackupEngine; db: BetterSqlite3.Database } {
  const database = db ?? openCatalogDb(root);
  if (!db) openDbs.push(database);
  const engine = new BackupEngine(
    {
      root,
      nodeId: 'node-1',
      serverUrl: 'https://api.test',
      kind,
      trigger: 'manual',
      cliVersion: '1.2.23',
      concurrency: 2,
      maxMbps: 0,
      pageSize: 10,
      pacingMs: 0,
    },
    { api, db: database, sleep: async () => {} },
  );
  engine.on('error', () => {});
  return { engine, db: database };
}

/** Recursively list files under root, excluding the .memoriahub state dir. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.memoriahub') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-cadence
// ---------------------------------------------------------------------------

describe('reconcile auto-cadence', () => {
  const now = new Date('2024-03-01T00:00:00.000Z');

  it('shouldAutoReconcile is true when a reconcile has never run', () => {
    expect(shouldAutoReconcile(null, now)).toBe(true);
    expect(shouldAutoReconcile(undefined, now)).toBe(true);
  });

  it('is true once the last reconcile is RECONCILE_EVERY_DAYS old', () => {
    const old = new Date(now.getTime() - RECONCILE_EVERY_DAYS * 86_400_000).toISOString();
    expect(shouldAutoReconcile(old, now)).toBe(true);
  });

  it('is false for a recent reconcile', () => {
    const recent = new Date(now.getTime() - 5 * 86_400_000).toISOString();
    expect(shouldAutoReconcile(recent, now)).toBe(false);
  });

  it('treats an unparsable timestamp as "never reconciled"', () => {
    expect(shouldAutoReconcile('not-a-date', now)).toBe(true);
  });

  it('resolveRunKind: --reconcile forces a reconcile without calling the server', async () => {
    let called = false;
    const api = {
      getNodeBackupConfig: async (): Promise<NodeBackupConfigResult> => {
        called = true;
        return { config: null };
      },
    };
    const res = await resolveRunKind(api, 'node-1', true, now);
    expect(res).toEqual({ kind: 'reconcile', reason: 'forced' });
    expect(called).toBe(false);
  });

  it('resolveRunKind: auto-upgrades when lastReconcileAt is older than 30 days', async () => {
    const stale = new Date(now.getTime() - 31 * 86_400_000).toISOString();
    const api = {
      getNodeBackupConfig: async (): Promise<NodeBackupConfigResult> => ({
        config: {
          nodeId: 'node-1',
          enabled: true,
          scheduleCron: null,
          timezone: null,
          circleIds: [],
          lastReconcileAt: stale,
        },
      }),
    };
    const res = await resolveRunKind(api, 'node-1', false, now);
    expect(res).toEqual({ kind: 'reconcile', reason: 'auto' });
  });

  it('resolveRunKind: stays incremental for a recent reconcile', async () => {
    const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const api = {
      getNodeBackupConfig: async (): Promise<NodeBackupConfigResult> => ({
        config: {
          nodeId: 'node-1',
          enabled: true,
          scheduleCron: null,
          timezone: null,
          circleIds: [],
          lastReconcileAt: recent,
        },
      }),
    };
    const res = await resolveRunKind(api, 'node-1', false, now);
    expect(res).toEqual({ kind: 'incremental', reason: null });
  });

  it('resolveRunKind: an unreachable config check degrades to incremental', async () => {
    const api = {
      getNodeBackupConfig: async (): Promise<NodeBackupConfigResult> => {
        throw new Error('network down');
      },
    };
    const res = await resolveRunKind(api, 'node-1', false, now);
    expect(res).toEqual({ kind: 'incremental', reason: null });
  });
});

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

describe('reconcile quarantine', () => {
  it('moves a manifest-absent item (file + sidecar) into _quarantine/ and never deletes it', async () => {
    const contents = new Map<string, Buffer>();
    const keep = withContent(feedItem({ id: 'keep-1' }), contents, Buffer.from('keeper bytes'));
    const gone = withContent(feedItem({ id: 'gone-1' }), contents, Buffer.from('doomed bytes'));

    // Pass 1: both items land locally.
    const fake = makeApi(chainPages([[keep, gone]]), contents, [manifestRow(keep), manifestRow(gone)]);
    const { engine, db } = makeEngine(fake.api, 'incremental');
    await engine.runBackup();

    const repo = new CatalogRepo(db);
    const goneRow = repo.getById('gone-1')!;
    expect(goneRow.status).toBe('present');
    expect(fs.existsSync(absPathFor(root, goneRow.relPath))).toBe(true);

    // Pass 2 (reconcile): the server no longer lists gone-1 at all.
    fake.state.pages = chainPages([[]]);
    fake.state.manifest = [manifestRow(keep)];
    const { engine: reconcileEngine } = makeEngine(fake.api, 'reconcile', db);
    const outcome = await reconcileEngine.runBackup();

    expect(outcome.status).toBe('completed');
    expect(outcome.reconcile).toMatchObject({ manifestIds: 1, quarantined: 1, driftMarked: 0 });

    const quarantined = repo.getById('gone-1')!;
    expect(quarantined.status).toBe('quarantined');
    expect(quarantined.relPath.startsWith(`${QUARANTINE_DIR}/`)).toBe(true);
    expect(quarantined.lastError).toMatch(/reconcile run/i);
    expect(quarantined.lastError).toMatch(/absent from server manifest/i);

    // The BYTES still exist — just relocated, preserving the original subtree.
    const quarantinedAbs = absPathFor(root, quarantined.relPath);
    expect(fs.existsSync(quarantinedAbs)).toBe(true);
    expect(fs.readFileSync(quarantinedAbs).toString()).toBe('doomed bytes');
    expect(fs.existsSync(`${quarantinedAbs}.json`)).toBe(true);
    expect(fs.existsSync(absPathFor(root, goneRow.relPath))).toBe(false);
    expect(quarantined.relPath).toBe(quarantineRelPathFor(goneRow.relPath));

    // The kept item is untouched.
    const keptRow = repo.getById('keep-1')!;
    expect(keptRow.status).toBe('present');
    expect(fs.existsSync(absPathFor(root, keptRow.relPath))).toBe(true);

    // Nothing was unlinked: both media files + both sidecars are still on disk.
    const files = listFiles(root).filter((f) => !f.startsWith('catalog/'));
    expect(files.filter((f) => f.endsWith('.jpg'))).toHaveLength(2);
    expect(files.filter((f) => f.endsWith('.jpg.json'))).toHaveLength(2);
  });

  it('quarantines a failed row whose bytes never downloaded (catalog-only move)', async () => {
    const db = openCatalogDb(root);
    openDbs.push(db);
    const repo = new CatalogRepo(db);
    repo.upsertItemWithDims(
      {
        mediaItemId: 'never-downloaded',
        circleId: 'circle-1',
        relPath: 'media/2024/02/nd.jpg',
        sidecarRelPath: 'media/2024/02/nd.jpg.json',
        capturedAt: '2024-02-01T10:00:00.000Z',
        contentHash: null,
        size: null,
        mimeType: 'image/jpeg',
        serverUpdatedAt: '2024-02-01T00:00:00.000Z',
        status: 'failed',
        archived: false,
        downloadedAt: null,
        verifiedAt: null,
        lastError: 'no download URL available for this item',
      },
      {},
    );

    const fake = makeApi([], new Map(), []);
    const summary = await performReconcile(
      { root, nodeId: 'node-1', runId: 'run-x' },
      { api: fake.api, db },
    );

    expect(summary.quarantined).toBe(1);
    const row = repo.getById('never-downloaded')!;
    expect(row.status).toBe('quarantined');
    expect(row.relPath).toBe('_quarantine/media/2024/02/nd.jpg');
  });
});

// ---------------------------------------------------------------------------
// Manifest streaming
// ---------------------------------------------------------------------------

describe('reconcile manifest streaming', () => {
  it('streams multiple id-keyset pages into the temp table and drops it afterwards', async () => {
    const db = openCatalogDb(root);
    openDbs.push(db);

    const manifest: BackupManifestItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `item-${String(i).padStart(2, '0')}`,
      contentHash: null,
      updatedAt: '2024-02-01T00:00:00.000Z',
      deletedAt: null,
      archivedAt: null,
    }));

    const fake = makeApi([], new Map(), manifest, { manifestPageSize: 3 });
    const summary = await performReconcile(
      { root, nodeId: 'node-1', runId: 'run-m', pageSize: 3 },
      { api: fake.api, db },
    );

    expect(summary.manifestIds).toBe(7);
    // 3 + 3 + 1 → three pages, keyed by the previous page's last id.
    expect(fake.manifestCalls).toEqual([null, 'item-02', 'item-05']);

    // The temp table is connection-scoped and dropped on finish.
    const temp = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_temp_master WHERE type='table' AND name='reconcile_ids'",
      )
      .get();
    expect(temp).toBeUndefined();
  });

  it('a cancelled stream applies NO diff', async () => {
    const db = openCatalogDb(root);
    openDbs.push(db);
    const repo = new CatalogRepo(db);
    repo.upsertItemWithDims(
      {
        mediaItemId: 'orphan',
        circleId: 'circle-1',
        relPath: 'media/2024/02/orphan.jpg',
        sidecarRelPath: 'media/2024/02/orphan.jpg.json',
        capturedAt: null,
        contentHash: 'abc',
        size: 3,
        mimeType: 'image/jpeg',
        serverUpdatedAt: '2024-02-01T00:00:00.000Z',
        status: 'present',
        archived: false,
        downloadedAt: '2024-02-01T00:00:00.000Z',
        verifiedAt: '2024-02-01T00:00:00.000Z',
        lastError: null,
      },
      {},
    );

    const fake = makeApi([], new Map(), []);
    const summary = await performReconcile(
      { root, nodeId: 'node-1', runId: 'run-c' },
      { api: fake.api, db, isCancelled: () => true },
    );

    expect(summary.cancelled).toBe(true);
    expect(summary.quarantined).toBe(0);
    expect(repo.getById('orphan')!.status).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// Hash drift → re-download on the NEXT incremental pass
// ---------------------------------------------------------------------------

describe('reconcile hash drift', () => {
  it('marks a drifted item for re-download and the next incremental pass re-fetches it', async () => {
    const contents = new Map<string, Buffer>();
    const original = Buffer.from('version one');
    const item = withContent(feedItem({ id: 'drift-1' }), contents, original);

    // Pass 1: normal incremental download.
    const fake = makeApi(chainPages([[item]]), contents, [manifestRow(item)]);
    const { engine, db } = makeEngine(fake.api, 'incremental');
    await engine.runBackup();

    const repo = new CatalogRepo(db);
    const before = repo.getById('drift-1')!;
    expect(before.status).toBe('present');
    expect(before.contentHash).toBe(sha256(original));
    expect(fake.getRawCalls.get(item.downloadUrl as string)).toBe(1);

    // Pass 2 (reconcile): the server reports a DIFFERENT contentHash for the
    // same item, and the change feed is quiet (the drift is what reconcile is
    // for — the feed alone would never surface it).
    const replacement = Buffer.from('version two, edited server-side');
    const serverHash = sha256(replacement);
    fake.state.pages = chainPages([[]]);
    fake.state.manifest = [{ ...manifestRow(item), contentHash: serverHash }];

    const { engine: reconcileEngine } = makeEngine(fake.api, 'reconcile', db);
    const outcome = await reconcileEngine.runBackup();
    expect(outcome.reconcile).toMatchObject({ quarantined: 0, driftMarked: 1 });

    const marked = repo.getById('drift-1')!;
    expect(marked.status).toBe('failed');
    expect(marked.contentHash).toBeNull();
    expect(marked.verifiedAt).toBeNull();
    expect(marked.lastError).toMatch(/contentHash drift/i);

    // Pass 3 (incremental): the feed now serves the updated item, and the
    // engine's failed-row classification re-downloads its bytes.
    const updated: BackupChangeItem = {
      ...item,
      updatedAt: '2024-02-02T00:00:00.000Z',
      contentHash: serverHash,
      storage: {
        ...(item.storage as NonNullable<BackupChangeItem['storage']>),
        size: String(replacement.length),
      },
    };
    contents.set(updated.downloadUrl as string, replacement);
    fake.state.pages = chainPages([[updated]]);
    fake.state.manifest = [manifestRow(updated)];

    const { engine: pass3 } = makeEngine(fake.api, 'incremental', db);
    await pass3.runBackup();

    expect(fake.getRawCalls.get(item.downloadUrl as string)).toBe(2);
    const healed = repo.getById('drift-1')!;
    expect(healed.status).toBe('present');
    expect(healed.contentHash).toBe(serverHash);
    expect(fs.readFileSync(absPathFor(root, healed.relPath)).toString()).toBe(
      'version two, edited server-side',
    );
  });

  it('a failed row is re-downloaded even when the feed item is otherwise unchanged', async () => {
    // Guards the exact path reconcile's drift marking relies on: content_hash
    // cleared + status='failed' must make the engine re-fetch, NOT skip.
    const contents = new Map<string, Buffer>();
    const bytes = Buffer.from('stable bytes');
    const item = withContent(feedItem({ id: 'refetch-1' }), contents, bytes);

    const fake = makeApi(chainPages([[item]]), contents, [manifestRow(item)]);
    const { engine, db } = makeEngine(fake.api, 'incremental');
    await engine.runBackup();
    expect(fake.getRawCalls.get(item.downloadUrl as string)).toBe(1);

    const repo = new CatalogRepo(db);
    repo.markForRedownload('refetch-1', 'reconcile run run-y: server contentHash drift');
    expect(repo.getById('refetch-1')!.status).toBe('failed');

    // Same feed item, replayed: the failed row forces a fresh download.
    fake.state.pages = chainPages([[item]]);
    const { engine: pass2 } = makeEngine(fake.api, 'incremental', db);
    await pass2.runBackup();

    expect(fake.getRawCalls.get(item.downloadUrl as string)).toBe(2);
    expect(repo.getById('refetch-1')!.status).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// Run kind plumbing
// ---------------------------------------------------------------------------

describe('reconcile run kind', () => {
  it("starts the server run with kind 'reconcile' and records it locally", async () => {
    const contents = new Map<string, Buffer>();
    const fake = makeApi(chainPages([[]]), contents, []);
    const { engine, db } = makeEngine(fake.api, 'reconcile');
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    const run = new CatalogRepo(db).latestRun()!;
    expect(run.kind).toBe('reconcile');

    const manifestJson = JSON.parse(
      fs.readFileSync(absPathFor(root, 'catalog/manifest.json'), 'utf8'),
    ) as { lastRun: { kind: string } };
    expect(manifestJson.lastRun.kind).toBe('reconcile');
  });

  it('an incremental run never touches the manifest endpoint', async () => {
    const contents = new Map<string, Buffer>();
    const fake = makeApi(chainPages([[]]), contents, []);
    const { engine } = makeEngine(fake.api, 'incremental');
    const outcome = await engine.runBackup();

    expect(outcome.reconcile).toBeUndefined();
    expect(fake.manifestCalls).toHaveLength(0);
  });
});
