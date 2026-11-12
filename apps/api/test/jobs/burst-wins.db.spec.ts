/**
 * Real-Postgres tier (RETRO-C5, #594): burst wins over duplicate detection on
 * the native handlers.
 *
 * Two photos from one camera, two seconds apart, with the same perceptual hash
 * are both a burst and a near-duplicate pair. The upload path enqueues
 * `burst_detection` at priority 5 and `duplicate_detection` at 10, but either can
 * run first (a node can submit dedup's result before burst is claimed). Whatever
 * the order, each photo must end in the burst group and in no duplicate group:
 *
 *   * dedup's persist FIRST (the node path, `persistNodeResult`): it groups the
 *     pair as duplicates; burst then evicts both from the duplicate group.
 *   * burst FIRST: dedup's persist sees a pending burst member and writes no
 *     duplicate membership (the eligibility guard, then the `SELECT ... FOR
 *     UPDATE` re-check inside the membership transaction).
 *
 * The real services and handlers run against a real database; only the CLIP
 * model (degraded: embeddings are not stored, matching is dHash-only), the storage provider (never called: the hash
 * is present) and the enqueue service are doubles. Skips when no database is
 * reachable.
 */
import { randomUUID } from 'node:crypto';

import { BurstDetectionHandler, BurstDetectionService } from '@marinoscar/memoriahub-api/burst';
import { DuplicateDetectionHandler } from '@marinoscar/memoriahub-api/dedup';
import { DuplicateDetectionService } from '@marinoscar/memoriahub-api/dedup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { dropLibraries, newLibrary } from '../helpers/library';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { mediaItemJob } from '../helpers/platform-job';
import { seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

/** An unsigned 64-bit dHash as the decimal string the column stores. */
const HASH = '12297829382473034410';

describeMaybeDb('burst wins over duplicate detection (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let seed: SeedClient;
  let orgId: string;
  let userId: string;
  const circles: string[] = [];
  const objects: string[] = [];

  const registry = { register: jest.fn() };
  const noDownloadError = () => {
    throw new Error('no download expected: the hash is present');
  };
  const noDownload = { getProviderFor: async () => noDownloadError(), forLocation: async () => noDownloadError() };
  /** CLIP in degraded mode: dHash-only matching, no embedding rows. */
  const degradedClip = {
    isAvailable: () => false,
    hasEmbedding: async () => false,
    persistEmbedding: async () => undefined,
  };

  let dedupHandler: DuplicateDetectionHandler;
  let burstHandler: BurstDetectionHandler;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    const org = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`;
    if (org.length === 0) throw new Error('no organization row: run the migrations first');
    orgId = org[0]!.id;
    const user = await prisma.user.create({ data: { email: `burst-wins-${Date.now()}@example.test` } });
    userId = user.id;

    const settings = {
      readSystem: async (name: string) => ({
        value: name === 'dedup' ? { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20 } : undefined,
        version: 1,
      }),
    };
    const dedupService = new DuplicateDetectionService(
      prisma,
      noDownload as never,
      settings as never,
      degradedClip as never,
    );
    const burstService = new BurstDetectionService(
      prisma as never,
      noDownload as never,
      settings as never,
      dedupService,
    );
    dedupHandler = new DuplicateDetectionHandler(registry as never, prisma, dedupService);
    burstHandler = new BurstDetectionHandler(registry as never, prisma, burstService);
  });

  afterAll(async () => {
    for (const circleId of circles) {
      await seed.mediaItem.deleteMany({ where: { circleId } });
      await seed.burstGroup.deleteMany({ where: { circleId } });
      await seed.duplicateGroup.deleteMany({ where: { circleId } });
      await dropLibraries(prisma, [circleId]);
    }
    if (objects.length > 0) await seed.storageObject.deleteMany({ where: { id: { in: objects } } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** A circle with two burst-and-duplicate photos: A at t, B at t + 2 s. */
  async function seedPair(): Promise<{ circleId: string; a: string; b: string }> {
    const circle = await newLibrary(prisma, { ownerId: userId });
    circles.push(circle.id);
    const base = new Date('2026-06-20T10:00:00Z').getTime();
    const ids: string[] = [];
    for (const offsetMs of [0, 2_000]) {
      const objectId = randomUUID();
      await seed.$executeRaw`
        INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
        VALUES (${objectId}::uuid, ${orgId}::uuid, 'photo.jpg', 1024, 'image/jpeg', ${`uploads/${objectId}.jpg`}, 's3', 'ready', now())`;
      objects.push(objectId);
      const item = await seed.mediaItem.create({
        data: {
          storageObjectId: objectId,
          circleId: circle.id,
          addedById: userId,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
          capturedAt: new Date(base + offsetMs),
          cameraMake: 'Camera Co',
          cameraModel: 'Model X',
          perceptualHash: HASH,
        },
        select: { id: true },
      });
      ids.push(item.id);
    }
    return { circleId: circle.id, a: ids[0]!, b: ids[1]! };
  }

  async function memberships(ids: string[]) {
    return seed.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, burstGroupId: true, duplicateGroupId: true },
      orderBy: { capturedAt: 'asc' },
    });
  }

  /**
   * The node's duplicate_detection result for B: a 512-d embedding (the CLIP
   * double drops it, so no KNN row exists) and its hash, which is what links
   * the pair.
   */
  const nodeResult = {
    model: 'clip-vit-b32-q8',
    embedding: Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0.04 : -0.04)),
    dHash: HASH,
  };

  it('dedup persists first (node path), then burst: both photos end only in the burst group', async () => {
    const { circleId, a, b } = await seedPair();

    await dedupHandler.persistNodeResult(mediaItemJob('duplicate_detection', b, circleId), nodeResult);
    const afterDedup = await memberships([a, b]);
    expect(afterDedup.every((m) => m.duplicateGroupId !== null)).toBe(true);
    expect(afterDedup[0]!.duplicateGroupId).toBe(afterDedup[1]!.duplicateGroupId);

    await burstHandler.process(mediaItemJob('burst_detection', b, circleId));

    const after = await memberships([a, b]);
    expect(after.every((m) => m.burstGroupId !== null)).toBe(true);
    expect(after[0]!.burstGroupId).toBe(after[1]!.burstGroupId);
    expect(after.map((m) => m.duplicateGroupId)).toEqual([null, null]);
  });

  it('burst first, then dedup persists: no duplicate membership is ever written', async () => {
    const { circleId, a, b } = await seedPair();

    await burstHandler.process(mediaItemJob('burst_detection', b, circleId));
    await dedupHandler.persistNodeResult(mediaItemJob('duplicate_detection', b, circleId), nodeResult);
    await dedupHandler.process(mediaItemJob('duplicate_detection', a, circleId));

    const after = await memberships([a, b]);
    expect(after.every((m) => m.burstGroupId !== null)).toBe(true);
    expect(after.map((m) => m.duplicateGroupId)).toEqual([null, null]);
    await expect(seed.duplicateGroup.count({ where: { circleId } })).resolves.toBe(0);
  });
});
