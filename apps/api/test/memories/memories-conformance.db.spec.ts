// =============================================================================
// describeMemoriesSliceConformance on the real host (RETRO-J8, #619; retro-gaps audit)
// =============================================================================
//
// The kit's registration rules are run over in-memory fakes by `packages/memoriahub-api/test/
// memories-conformance.spec.ts`. Its BEHAVIOUR rules need a data path, so they run here, on the host's real
// PostgreSQL: the slice's own `MemoryCurationService`, `MemoriesService` and `MemoryDigestService` over the
// real `memories` / `memory_items` / `jobs` tables (the services take the row-level-security bypass
// connection, as the face slice conformance does; the seeding and every assertion go through the
// organization-scoped client). The two registration rules run over the real booted handler registry.
//
// DB_GATED: reported as skipped (never passed) when no database is reachable.
// =============================================================================

import { randomUUID } from 'node:crypto';

import {
  MemoriesService,
  MemoryCurationService,
  MemoryDigestService,
  MEMORY_DIGEST_JOB_TYPE,
  type MemoriesPreferencesValue,
} from '@marinoscar/memoriahub-api/memories';
import { describeMemoriesSliceConformance } from '@marinoscar/memoriahub-api/memories/testing';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { dropLibraries, newLibrary } from '../helpers/library';
import { rlsBypassPrisma, seedClient, type SeedClient } from '../helpers/org-scope';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('memories slice conformance (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: PrismaService;
  let seed: SeedClient;
  let context: TestContext;
  let orgId: string;
  const userIds: string[] = [];
  const libraries: string[] = [];
  const objects: string[] = [];
  const preferences = new Map<string, MemoriesPreferencesValue | undefined>();

  const curation = () => new MemoryCurationService(service as never, { generate: async () => null, beginRun: () => undefined } as never);

  const memories = () =>
    new MemoriesService(
      service as never,
      {
        requireOwnerRole: async () => ({ role: 'admin', bypass: false }),
        hasOwnerBypass: () => false,
        roleIn: async () => 'admin',
      } as never,
      { readUser: async (userId: string) => preferences.get(userId) } as never,
      { record: async () => undefined } as never,
      { extractThumbKey: () => null, signThumbsBatched: async () => new Map() } as never,
      { enabled: async () => true } as never,
      {} as never,
    );

  const digest = () => new MemoryDigestService(service as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    service = await rlsBypassPrisma();
    const org = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`;
    orgId = org[0]!.id;
    context = await createTestApp({ useMockDatabase: false });
  }, 90000);

  afterAll(async () => {
    for (const libraryId of libraries) {
      await seed.memory.deleteMany({ where: { circleId: libraryId } });
      await seed.person.deleteMany({ where: { circleId: libraryId } });
      await seed.mediaItem.deleteMany({ where: { circleId: libraryId } });
      await prisma.job.deleteMany({ where: { type: MEMORY_DIGEST_JOB_TYPE, subjectId: libraryId } });
      await dropLibraries(prisma, [libraryId]);
    }
    if (objects.length > 0) await seed.storageObject.deleteMany({ where: { id: { in: objects } } });
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (context) await closeTestApp(context);
    await service?.$disconnect();
    await prisma?.$disconnect();
  });

  async function seedWorld() {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((label) => prisma.user.create({ data: { email: `memories-conf-${label}-${randomUUID()}@example.test` } })),
    );
    userIds.push(a!.id, b!.id);
    const library = await newLibrary(prisma, { ownerId: a!.id, members: [{ userId: b!.id, role: 'editor' }] });
    libraries.push(library.id);

    const mediaItemIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const objectId = randomUUID();
      await seed.$executeRaw`
        INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
        VALUES (${objectId}::uuid, ${orgId}::uuid, 'photo.jpg', 1024, 'image/jpeg', ${`uploads/${objectId}.jpg`}, 's3', 'ready', now())`;
      objects.push(objectId);
      const item = await seed.mediaItem.create({
        data: {
          storageObjectId: objectId,
          circleId: library.id,
          addedById: a!.id,
          type: 'photo',
          source: 'web',
          originalFilename: `photo-${i}.jpg`,
          capturedAt: new Date('2024-11-12T10:00:00.000Z'),
        },
        select: { id: true },
      });
      mediaItemIds.push(item.id);
    }
    const person = await seed.person.create({ data: { circleId: library.id, addedById: a!.id, name: 'Person A' }, select: { id: true } });
    return { libraryId: library.id, userId: a!.id, otherUserId: b!.id, mediaItemIds, personId: person.id };
  }

  // The two registration rules run over the booted app's real job registry.
  describeMemoriesSliceConformance(
    { describe, it, expect } as never,
    {
      name: 'the web host (real PostgreSQL)',
      create: () => ({
        handlers: ['memory_generation', 'memory_digest'].map((type) => context.module.get(JobHandlerRegistry, { strict: false }).get(type) as never),
      }),
      behaviour: () => ({
        seedWorld,

        upsertMemory: async (input) => {
          const items = input.mediaItemIds.map((mediaItemId, position) => ({ mediaItemId, position, score: 1 }));
          const periodStart = new Date('2024-11-12T10:00:00.000Z');
          const result = await curation().upsertMemory({
            circleId: input.libraryId,
            type: input.type,
            periodKey: input.periodKey,
            ...(input.subjectKey !== undefined ? { subjectKey: input.subjectKey } : {}),
            personId: input.personId ?? null,
            title: input.title,
            selection: {
              items,
              coverMediaItemId: items[0]?.mediaItemId ?? null,
              periodStart,
              periodEnd: periodStart,
              candidateCount: items.length,
              truncated: false,
            },
          });
          return { memoryId: result.memoryId, created: result.created, skippedTombstone: result.skippedTombstone };
        },

        deleteMemory: (memoryId, userId) => memories().remove(memoryId, userId, []),

        memoryRows: async (libraryId) =>
          seed.memory.findMany({
            where: { circleId: libraryId },
            select: { id: true, type: true, periodKey: true, deletedAt: true, itemCount: true, title: true, refreshedAt: true },
            orderBy: { id: 'asc' },
          }),

        listFor: async (userId, libraryId) =>
          (await memories().list({ circleId: libraryId, pageSize: 50 } as never, userId, [])).items.map((card) => card.id),

        setPreferences: async (userId, prefs) => {
          preferences.set(userId, Object.keys(prefs).length === 0 ? undefined : prefs);
        },

        recordDigestJob: async (libraryId, status, finishedAt) => {
          await prisma.job.create({
            data: {
              type: MEMORY_DIGEST_JOB_TYPE,
              subjectType: 'circle',
              subjectId: libraryId,
              status,
              reason: 'rerun',
              finishedAt,
            } as never,
          });
        },

        digestWatermark: (libraryId) => digest().lastDigestAt(libraryId),
      }),
    },
  );
});
