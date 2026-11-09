// =============================================================================
// ObjectReprocessService and the content-addressed thumbnail invariant (RETRO-D1b, #567)
// =============================================================================
//
// `reprocessNow` is the one-object inline re-run the three synchronous HTTP
// callers keep (the platform exposes `ObjectProcessingService.run`, so they do
// not enqueue-and-wait; #567 open decision 1).
//
// The invariant (issue #434): after an in-place overwrite of an original's
// bytes, the destructive call sites run reprocess -> AWAIT metadata sync ->
// prune. Exercised here end to end over an in-memory world with the REAL
// `ThumbnailPruneService` and the REAL key builders: the new thumbnail lands at
// `thumbnails/<id>-<sha256(bytes)[0:16]>.jpg`, the media item points at it before
// anything is pruned, the old key is gone afterwards, and the node path's random
// version is pruned and kept by the same rule.
// =============================================================================

import { ObjectReprocessService } from '../../src/media-processing/recovery/object-reprocess.service';
import { ThumbnailPruneService } from '../../src/media-processing/thumbnail-prune.service';
import {
  buildThumbnailKey,
  randomThumbnailVersion,
  thumbnailVersionFromBytes,
} from '../../src/media-processing/thumbnail-key.util';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const SOURCE = '11111111-1111-4111-8111-111111111111';

describe('ObjectReprocessService.reprocessNow', () => {
  it('resets the object in its organization, clears retry bookkeeping, then runs the processors', async () => {
    const order: string[] = [];
    const update = jest.fn(async ({ data }: any) => {
      order.push('reset');
      return { id: SOURCE, orgId: ORG, ...data };
    });
    const prisma = { forOrg: jest.fn(() => ({ storageObject: { update } })) };
    const processing = {
      runNow: jest.fn(async () => {
        order.push('run');
        return 'ready';
      }),
    };
    const service = new ObjectReprocessService(prisma as never, processing as never);

    const outcome = await service.reprocessNow({
      id: SOURCE,
      orgId: ORG,
      status: 'failed',
      metadata: { _processingRetryCount: 3, _processingRetryExhausted: true, keep: 'me' },
    } as never);

    expect(outcome).toBe('ready');
    expect(prisma.forOrg).toHaveBeenCalledWith(ORG);
    expect(update).toHaveBeenCalledWith({
      where: { id: SOURCE },
      data: { status: 'processing', metadata: { keep: 'me' } },
    });
    expect(processing.runNow).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }));
    expect(order).toEqual(['reset', 'run']);
  });
});

// -----------------------------------------------------------------------------
// The thumbnail invariant
// -----------------------------------------------------------------------------

interface Row {
  id: string;
  storageKey: string;
  storageProvider: string;
  bucket: string | null;
  metadata: Record<string, any> | null;
}

function thumbnailWorld(initialThumbKey: string) {
  const rows = new Map<string, Row>();
  const deletedBytes: string[] = [];
  const events: string[] = [];
  const mediaItem = { thumbnailStorageKey: initialThumbKey };
  let nextId = 0;

  const addThumb = (key: string) => {
    const id = `thumb-${nextId++}`;
    rows.set(id, { id, storageKey: key, storageProvider: 'local', bucket: null, metadata: null });
  };
  rows.set(SOURCE, {
    id: SOURCE,
    storageKey: `uploads/${SOURCE}.jpg`,
    storageProvider: 'local',
    bucket: null,
    metadata: { _processing: { thumbnail: { thumbnailStorageKey: initialThumbKey } } },
  });
  addThumb(initialThumbKey);

  const prisma = {
    storageObject: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        [...rows.values()].filter(
          (r) => r.storageKey.startsWith(where.storageKey.startsWith) && r.storageKey !== where.NOT.storageKey.equals,
        ),
      ),
      delete: jest.fn(async ({ where }: any) => {
        // The invariant: nothing is pruned while the media item still points at it.
        if (rows.get(where.id)?.storageKey === mediaItem.thumbnailStorageKey) {
          throw new Error('pruned the thumbnail the media item still points at');
        }
        events.push(`prune:${rows.get(where.id)?.storageKey}`);
        rows.delete(where.id);
      }),
    },
  };
  const resolver = {
    getProviderFor: jest.fn(async () => ({ delete: async (key: string) => deletedBytes.push(key) })),
  };
  const prune = new ThumbnailPruneService(prisma as never, resolver as never);

  /** What the pipeline's thumbnail processor does: render, upsert at the versioned key, record it. */
  const renderThumbnail = (version: string) => {
    const key = buildThumbnailKey(SOURCE, version);
    addThumb(key);
    rows.get(SOURCE)!.metadata = { _processing: { thumbnail: { thumbnailStorageKey: key } } };
    events.push(`render:${key}`);
    return key;
  };
  /** What `MediaMetadataSyncService.syncFromStorageObject` does for the thumbnail. */
  const sync = async () => {
    mediaItem.thumbnailStorageKey = rows.get(SOURCE)!.metadata!['_processing'].thumbnail.thumbnailStorageKey;
    events.push(`sync:${mediaItem.thumbnailStorageKey}`);
  };
  return { rows, events, mediaItem, deletedBytes, prune, renderThumbnail, sync };
}

describe('content-addressed thumbnails: reprocess -> sync -> prune (issue #434)', () => {
  const oldKey = buildThumbnailKey(SOURCE, thumbnailVersionFromBytes(Buffer.from('old thumbnail bytes')));

  it('moves the item to thumbnails/<id>-<newhash>.jpg before the old key is pruned, and the old key is gone after', async () => {
    const w = thumbnailWorld(oldKey);
    const newBytes = Buffer.from('rotated thumbnail bytes');

    // reprocess (the processors run inside ObjectReprocessService.reprocessNow)
    const newKey = w.renderThumbnail(thumbnailVersionFromBytes(newBytes));
    await w.sync();
    const pruned = await w.prune.pruneSupersededThumbnails(SOURCE);

    expect(newKey).toBe(`thumbnails/${SOURCE}-${thumbnailVersionFromBytes(newBytes)}.jpg`);
    expect(newKey).not.toBe(oldKey);
    expect(w.mediaItem.thumbnailStorageKey).toBe(newKey);
    expect(pruned).toBe(1);
    expect(w.deletedBytes).toEqual([oldKey]);
    expect([...w.rows.values()].map((r) => r.storageKey)).not.toContain(oldKey);
    expect(w.events).toEqual([`render:${newKey}`, `sync:${newKey}`, `prune:${oldKey}`]);
  });

  it('a prune run BEFORE the sync would delete the key the item still points at (the order is load-bearing)', async () => {
    const w = thumbnailWorld(oldKey);
    w.renderThumbnail(thumbnailVersionFromBytes(Buffer.from('rotated thumbnail bytes')));

    // Prune first: the source row already names the new key, so the old one is
    // "superseded", but the media item still points at it. The world refuses.
    await w.prune.pruneSupersededThumbnails(SOURCE);

    expect(w.mediaItem.thumbnailStorageKey).toBe(oldKey);
    expect([...w.rows.values()].map((r) => r.storageKey)).toContain(oldKey); // the row survived (prune is best-effort)
    expect(w.deletedBytes).toEqual([oldKey]); // ...but the BYTES were already gone: a broken tile
  });

  it('unchanged bytes re-render to the same key: nothing to prune', async () => {
    const w = thumbnailWorld(oldKey);
    w.renderThumbnail(thumbnailVersionFromBytes(Buffer.from('old thumbnail bytes')));
    await w.sync();
    expect(await w.prune.pruneSupersededThumbnails(SOURCE)).toBe(0);
  });

  it('a node-rendered thumbnail at a random version is kept and supersedes the old key the same way', async () => {
    const w = thumbnailWorld(oldKey);
    const version = randomThumbnailVersion();
    const nodeKey = w.renderThumbnail(version);
    await w.sync();
    await w.prune.pruneSupersededThumbnails(SOURCE);

    expect(nodeKey).toMatch(new RegExp(`^thumbnails/${SOURCE}-[0-9a-f]{16}\\.jpg$`));
    expect(w.mediaItem.thumbnailStorageKey).toBe(nodeKey);
    expect(w.deletedBytes).toEqual([oldKey]);
  });
});
