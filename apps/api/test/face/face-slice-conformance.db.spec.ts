// =============================================================================
// describeFaceSliceConformance against the web app's real database (RETRO-J6, #615)
// =============================================================================
//
// The same kit `packages/memoriahub-api/test/face-conformance.spec.ts` runs over in-memory fakes, run
// here on a REAL PostgreSQL with pgvector: the face slice's services are built over the app's
// `PrismaService` (the `MEMORIAHUB_PRISMA` binding), the faces live in the real `faces` table with its
// trigger-maintained `embedding_vec` column and three HNSW indexes, and the `knn` section compares BOTH
// vector backends on the same fixture: `app` (in-process cosine over `embedding`) and `pgvector` (the
// indexed KNN over `embedding_vec`). The jobs, the fan-out registry and the host hooks are the package's
// own (`face-conformance.spec.ts`); here only the data path is under test. Skips when no database is
// reachable.
// =============================================================================

import { randomUUID } from 'node:crypto';

import {
  FaceClusteringService,
  FaceDetectionCore,
  FaceDetectionService,
  FaceMatchingService,
  type FaceConfigReader,
} from '@marinoscar/memoriahub-api/face';
import { describeFaceSliceConformance, faceFixtureVector } from '@marinoscar/memoriahub-api/face/testing';
import { MediaTouchService } from '@marinoscar/memoriahub-api/media';

import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { dropLibraries, newLibrary } from '../helpers/library';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const configFor = (backend: 'app' | 'pgvector'): FaceConfigReader => ({
  get: <T = string>(key: string): T | undefined => (key === 'FACE_VECTOR_BACKEND' ? (backend as unknown as T) : undefined),
});

describeMaybeDb('face slice conformance (DB_GATED: real PostgreSQL with pgvector)', () => {
  let prisma: PrismaService;
  let orgId: string;
  let userId: string;
  const libraries: string[] = [];
  const objects: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const org = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`;
    if (org.length === 0) throw new Error('no organization row: run the migrations first');
    orgId = org[0]!.id;
    userId = (await prisma.user.create({ data: { email: `face-slice-${Date.now()}@example.test` } })).id;
  });

  afterAll(async () => {
    for (const circleId of libraries) {
      await prisma.person.deleteMany({ where: { circleId } });
      await prisma.mediaItem.deleteMany({ where: { circleId } });
      await dropLibraries(prisma, [circleId]);
    }
    if (objects.length > 0) await prisma.storageObject.deleteMany({ where: { id: { in: objects } } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** A new library with one photo, which every seeded face belongs to. */
  async function seedLibrary(): Promise<{ circleId: string; mediaItemId: string }> {
    const circle = await newLibrary(prisma, { ownerId: userId });
    libraries.push(circle.id);
    const objectId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
      VALUES (${objectId}::uuid, ${orgId}::uuid, 'photo.jpg', 1024, 'image/jpeg', ${`uploads/${objectId}.jpg`}, 's3', 'ready', now())`;
    objects.push(objectId);
    const item = await prisma.mediaItem.create({
      data: {
        storageObjectId: objectId,
        circleId: circle.id,
        addedById: userId,
        type: 'photo',
        source: 'web',
        originalFilename: 'photo.jpg',
      },
      select: { id: true },
    });
    return { circleId: circle.id, mediaItemId: item.id };
  }

  async function faceSliceOverTheWebHost() {
    const { circleId, mediaItemId } = await seedLibrary();
    const keys = new Map<string, string>();
    const matching = (backend: 'app' | 'pgvector') => new FaceMatchingService(prisma as never, configFor(backend));
    const appMatching = matching('app');
    const core = new FaceDetectionCore(
      prisma as never,
      { resolveCredentials: async () => ({}) } as never,
      { get: () => ({ detect: async () => [] }) } as never,
      appMatching,
      { getSettings: async () => ({ features: {}, face: {} }), face: async () => undefined } as never,
    );
    const detection = new FaceDetectionService(
      prisma as never,
      {} as never,
      { recordModel: async () => undefined } as never,
      core,
      new MediaTouchService(prisma as never),
    );

    const addFace = async (key: string, data: Record<string, unknown>): Promise<string> => {
      const row = await prisma.face.create({
        data: {
          mediaItemId,
          circleId,
          boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          providerKey: 'compreface',
          modelVersion: 'mobilenet',
          ...data,
        } as never,
        select: { id: true },
      });
      keys.set(key, row.id);
      return row.id;
    };

    return {
      rerun: {
        service: detection,
        circleId,
        mediaItemId,
        seedFaces: async (faces: ReadonlyArray<{ key: string; manuallyAssigned: boolean }>) => {
          for (const f of faces) await addFace(f.key, { manuallyAssigned: f.manuallyAssigned, embedding: [] });
        },
        faceKeys: async () => {
          const ids = (await prisma.face.findMany({ where: { mediaItemId }, select: { id: true } })).map((r) => r.id);
          return [...keys.entries()].filter(([, id]) => ids.includes(id)).map(([key]) => key);
        },
      },
      clustering: {
        service: new FaceClusteringService(prisma as never, appMatching),
        circleId,
        userId,
        seedFaces: async (faces: ReadonlyArray<{ key: string; embedding: number[]; hidden: boolean }>) => {
          for (const f of faces) await addFace(f.key, { embedding: f.embedding, hiddenAt: f.hidden ? new Date() : null });
        },
        personOf: async (key: string) =>
          (await prisma.face.findUnique({ where: { id: keys.get(key)! }, select: { personId: true } }))?.personId ?? null,
      },
      autoArchive: {
        service: matching('pgvector'),
        circleId,
        seedPool: async (embedding: number[]) => {
          const person = await prisma.person.create({ data: { circleId, addedById: userId, name: 'Person A' } as never, select: { id: true } });
          const archived = await addFace('archived', { embedding, hiddenAt: new Date() });
          await addFace('live', { embedding });
          await addFace('assigned', { embedding, hiddenAt: new Date(), personId: person.id });
          return archived;
        },
      },
      knn: {
        circleId,
        backends: [
          { name: 'app', service: appMatching },
          { name: 'pgvector', service: matching('pgvector') },
        ],
        seedPeople: async () => {
          const ids: string[] = [];
          for (const [i, axis] of [2, 11, 40].entries()) {
            const person = await prisma.person.create({ data: { circleId, addedById: userId, name: `Person ${i}` } as never, select: { id: true } });
            ids.push(person.id);
            for (const n of [1, 2]) await addFace(`p${i}-${n}`, { personId: person.id, embedding: faceFixtureVector(axis, 0.02 * n) });
          }
          return ids;
        },
      },
    };
  }

  describeFaceSliceConformance({ describe, it, expect }, { name: 'web app host, real database', create: faceSliceOverTheWebHost });
});
