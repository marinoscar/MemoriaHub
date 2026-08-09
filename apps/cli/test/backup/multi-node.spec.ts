/**
 * test/backup/multi-node.spec.ts — Two nodes backing up the SAME server state
 * into two independent roots (issue #320).
 *
 * The contract under test (documented in backup-engine.ts's header): each
 * machine binds exactly ONE backup root, and nodes never coordinate with each
 * other. Every node keeps its own local catalog + mirrored checkpoint and its
 * own SERVER-side checkpoint row keyed by nodeId, so:
 *
 *   - checkpoints advance independently — node A can be three pages ahead of
 *     node B without either noticing;
 *   - node A's ack NEVER moves node B's cursor (the fake server keeps one
 *     checkpoint per nodeId, exactly as NodeBackupConfig does);
 *   - both nonetheless converge on byte-identical local content, purely by
 *     each replaying the same server change feed from its own position.
 *
 * The fake server here is deliberately ONE shared object serving both nodes,
 * so a bug that let one node's ack leak into the other's cursor would show up
 * as a missing item rather than passing silently.
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
  BackupFeedCursor,
  GetRawOptions,
  GetRawResult,
} from '../../src/api.js';
import { BackupEngine, CHECKPOINT_CURSOR_KEY, type BackupApi } from '../../src/backup/backup-engine.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { absPathFor } from '../../src/backup/layout.js';

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// A tiny shared "server": an ordered item log + ONE checkpoint per nodeId
// ---------------------------------------------------------------------------

interface ServerItem {
  item: BackupChangeItem;
  content: Buffer;
}

class FakeServer {
  /** The ordered change feed, exactly as both nodes see it. */
  readonly log: ServerItem[] = [];
  /** Per-NODE checkpoint — the isolation this suite exists to prove. */
  readonly checkpoints = new Map<string, BackupFeedCursor | null>();
  /** Per-node ack log, for assertions. */
  readonly acks = new Map<string, BackupAckBody[]>();

  private seq = 0;

  add(id: string, body: string): ServerItem {
    this.seq++;
    const content = Buffer.from(body);
    const entry: ServerItem = {
      content,
      item: {
        id,
        circleId: 'circle-1',
        updatedAt: `2024-04-01T00:00:${String(this.seq).padStart(2, '0')}.000Z`,
        createdAt: '2024-01-01T00:00:00.000Z',
        capturedAt: '2024-04-01T10:00:00.000Z',
        capturedAtOffset: 0,
        type: 'photo',
        deletedAt: null,
        archivedAt: null,
        contentHash: sha256(content),
        originalFilename: `${id}.jpg`,
        storage: {
          objectId: `obj-${id}`,
          size: String(content.length),
          mimeType: 'image/jpeg',
          status: 'ready',
        },
        downloadUrl: `https://s3.test/${id}`,
        downloadUrlExpiresAt: null,
        sidecar: { schemaVersion: 1, mediaItemId: id, tags: [], albums: [], people: [] },
      },
    };
    this.log.push(entry);
    return entry;
  }

  /** Index of the first item strictly after `cursor` in the ordered log. */
  private startIndex(cursor: BackupFeedCursor | null | undefined): number {
    if (!cursor) return 0;
    const idx = this.log.findIndex((e) => e.item.id === cursor.id);
    return idx < 0 ? 0 : idx + 1;
  }

  page(cursor: BackupFeedCursor | null | undefined, limit: number): BackupChangesPage {
    const start = this.startIndex(cursor);
    const slice = this.log.slice(start, start + limit);
    const last = slice.length > 0 ? slice[slice.length - 1]! : undefined;
    return {
      items: slice.map((e) => e.item),
      nextCursor: last ? { updatedAt: last.item.updatedAt, id: last.item.id } : null,
      hasMore: start + slice.length < this.log.length,
      safetyHorizon: '2024-04-02T00:00:00.000Z',
    };
  }

  /** The API slice ONE node talks to. Every call carries its own nodeId. */
  apiFor(nodeId: string): BackupApi {
    this.checkpoints.set(nodeId, this.checkpoints.get(nodeId) ?? null);
    this.acks.set(nodeId, this.acks.get(nodeId) ?? []);
    let runCounter = 0;

    return {
      startNodeBackupRun: (async (callerNodeId: string, body: { kind: string }) => {
        const cp = this.checkpoints.get(callerNodeId) ?? null;
        return {
          run: {
            id: `${callerNodeId}-run-${++runCounter}`,
            kind: body.kind,
            startedAt: '2024-04-01T00:00:00.000Z',
            cursorStart: { updatedAt: cp?.updatedAt ?? null, id: cp?.id ?? null },
          },
        };
      }) as BackupApi['startNodeBackupRun'],

      getNodeBackupChanges: (async (
        _callerNodeId: string,
        q: { cursor?: BackupFeedCursor | null; limit?: number },
      ) => this.page(q.cursor, q.limit ?? 100)) as BackupApi['getNodeBackupChanges'],

      // The isolation point: an ack writes ONLY the calling node's checkpoint.
      ackNodeBackup: (async (callerNodeId: string, body: BackupAckBody) => {
        this.checkpoints.set(callerNodeId, body.cursor);
        this.acks.get(callerNodeId)!.push(body);
        return { ok: true as const, checkpoint: body.cursor };
      }) as BackupApi['ackNodeBackup'],

      finishNodeBackupRun: (async () => ({ ok: true as const })) as BackupApi['finishNodeBackupRun'],

      getNodeBackupDimensions: (async () => ({
        albums: [],
        people: [],
        tags: [],
        generatedAt: '2024-04-01T02:00:00.000Z',
      })) as BackupApi['getNodeBackupDimensions'],

      getNodeBackupManifest: (async () => ({
        items: this.log.map((e) => ({
          id: e.item.id,
          contentHash: e.item.contentHash,
          updatedAt: e.item.updatedAt,
          deletedAt: null,
          archivedAt: null,
        })),
        nextAfterId: null,
        hasMore: false,
      })) as BackupApi['getNodeBackupManifest'],

      getRaw: (async (url: string, destPath: string, o?: GetRawOptions): Promise<GetRawResult> => {
        const entry = this.log.find((e) => e.item.downloadUrl === url);
        if (!entry) throw new Error(`no content for ${url}`);
        const cfg = (await o?.attempt?.()) ?? {};
        await cfg.onResponse?.({ status: 200, resumed: false });
        await cfg.onChunk?.(Buffer.from(entry.content));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, entry.content);
        return { status: 200, bytesWritten: entry.content.length };
      }) as BackupApi['getRaw'],
    };
  }
}

// ---------------------------------------------------------------------------
// Per-node harness: its OWN root, its OWN catalog
// ---------------------------------------------------------------------------

interface Node {
  nodeId: string;
  root: string;
  db: BetterSqlite3.Database;
  repo: CatalogRepo;
  api: BackupApi;
}

let tmpDir: string;
const openDbs: BetterSqlite3.Database[] = [];

function makeNode(server: FakeServer, nodeId: string): Node {
  const root = path.join(tmpDir, nodeId);
  const db = openCatalogDb(root);
  openDbs.push(db);
  return { nodeId, root, db, repo: new CatalogRepo(db), api: server.apiFor(nodeId) };
}

async function runOnce(node: Node, pageSize = 100): Promise<void> {
  const engine = new BackupEngine(
    {
      root: node.root,
      nodeId: node.nodeId,
      serverUrl: 'https://api.test',
      trigger: 'manual',
      cliVersion: '1.2.23',
      concurrency: 2,
      maxMbps: 0,
      pageSize,
      pacingMs: 0,
    },
    { api: node.api, db: node.db, sleep: async () => {} },
  );
  engine.on('error', () => {});
  await engine.runBackup();
}

/** Every media file + sidecar under a root, relative, sorted. */
function contentFingerprint(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.memoriahub' || entry.name === 'catalog') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out.push([rel, sha256(fs.readFileSync(abs))]);
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function localCursor(node: Node): { updatedAt: string; id: string } | null {
  const raw = node.repo.getCheckpoint(CHECKPOINT_CURSOR_KEY);
  return raw ? (JSON.parse(raw) as { updatedAt: string; id: string }) : null;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-multinode-'));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('two nodes, one server', () => {
  it('advance their checkpoints independently and converge on identical content', async () => {
    const server = new FakeServer();
    for (let i = 0; i < 6; i++) server.add(`item-${i}`, `bytes for item ${i}`);

    const nodeA = makeNode(server, 'node-a');
    const nodeB = makeNode(server, 'node-b');

    // Node A syncs everything; node B has not run at all yet.
    await runOnce(nodeA);
    expect(server.checkpoints.get('node-a')?.id).toBe('item-5');
    expect(server.checkpoints.get('node-b')).toBeNull();
    expect(localCursor(nodeA)?.id).toBe('item-5');
    expect(localCursor(nodeB)).toBeNull();
    expect(nodeB.repo.stats().totalItems).toBe(0);

    // Node B now catches up from ITS OWN (empty) checkpoint and must receive
    // every item, not just the ones added after node A finished.
    await runOnce(nodeB);
    expect(server.checkpoints.get('node-b')?.id).toBe('item-5');
    expect(nodeB.repo.stats().totalItems).toBe(6);

    // Byte-identical local content, reached with no coordination.
    const fpA = contentFingerprint(nodeA.root);
    const fpB = contentFingerprint(nodeB.root);
    expect(fpA).toHaveLength(12); // 6 media files + 6 sidecars
    expect(fpB).toEqual(fpA);
  });

  it("node A's ack never moves node B's cursor", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 4; i++) server.add(`x-${i}`, `payload ${i}`);

    const nodeA = makeNode(server, 'node-a');
    const nodeB = makeNode(server, 'node-b');

    // B syncs the first two items only (one page at a time, one run).
    await runOnce(nodeB, 2);
    const bCursorAfterFirst = server.checkpoints.get('node-b');
    expect(bCursorAfterFirst?.id).toBe('x-3');

    // Reset B to a partial position to model "B is behind A".
    server.checkpoints.set('node-b', { updatedAt: '2024-04-01T00:00:01.000Z', id: 'x-0' });

    // A now runs to completion and acks repeatedly.
    await runOnce(nodeA, 1);
    expect(server.checkpoints.get('node-a')?.id).toBe('x-3');
    expect(server.acks.get('node-a')!.length).toBeGreaterThan(1);

    // B's server-side cursor is exactly where we left it — A never touched it.
    expect(server.checkpoints.get('node-b')).toEqual({
      updatedAt: '2024-04-01T00:00:01.000Z',
      id: 'x-0',
    });
    // And no ack was ever attributed to B during A's run.
    expect(server.acks.get('node-b')!.every((a) => a.runId.startsWith('node-b-run'))).toBe(true);
  });

  it('a node added later backfills the whole history without disturbing the first', async () => {
    const server = new FakeServer();
    server.add('early-1', 'early one');
    server.add('early-2', 'early two');

    const nodeA = makeNode(server, 'node-a');
    await runOnce(nodeA);
    const aCursorBefore = server.checkpoints.get('node-a');
    const aFingerprintBefore = contentFingerprint(nodeA.root);

    // A brand-new machine binds its own root much later.
    server.add('late-1', 'late one');
    const nodeB = makeNode(server, 'node-b');
    await runOnce(nodeB);

    expect(nodeB.repo.stats().totalItems).toBe(3);
    // A is untouched by B's full backfill — its server cursor did not move.
    expect(server.checkpoints.get('node-a')).toEqual(aCursorBefore);
    expect(contentFingerprint(nodeA.root)).toEqual(aFingerprintBefore);

    // A then picks up only the ONE new item from its own position.
    await runOnce(nodeA);
    expect(nodeA.repo.stats().totalItems).toBe(3);
    expect(contentFingerprint(nodeA.root)).toEqual(contentFingerprint(nodeB.root));
  });

  it('keeps each root\'s catalog in its own directory', async () => {
    const server = new FakeServer();
    server.add('only-1', 'bytes');

    const nodeA = makeNode(server, 'node-a');
    const nodeB = makeNode(server, 'node-b');
    await runOnce(nodeA);

    // The catalog travels with the FOLDER: B's root has its own, still empty.
    expect(fs.existsSync(absPathFor(nodeA.root, '.memoriahub/backup.db'))).toBe(true);
    expect(fs.existsSync(absPathFor(nodeB.root, '.memoriahub/backup.db'))).toBe(true);
    expect(nodeA.repo.stats().totalItems).toBe(1);
    expect(nodeB.repo.stats().totalItems).toBe(0);
    expect(path.dirname(nodeA.root)).toBe(path.dirname(nodeB.root));
    expect(nodeA.root).not.toBe(nodeB.root);
  });
});
