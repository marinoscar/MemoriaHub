// =============================================================================
// Cancelling an enhancement batch over real PostgreSQL (RETRO-C4 #590, epic #420; retro-gaps audit)
// =============================================================================
//
// The batch is a grouping over ordinary `picture_enhancement` jobs. Cancelling it must withdraw the work that has
// not started and leave the work that has:
//
//   - a `pending` enhancement is marked `cancelled` AND its queued job row is deleted (matched on the
//     `enhancementId` in the payload, never by media item, so an unrelated job of the same item survives);
//   - a `processing` enhancement is left to finish (it is already billed): its row and its running job are untouched;
//   - a `ready` enhancement (already reviewable) is untouched;
//   - the batch records `cancelledAt`, the response counts what was withdrawn, a second cancel is refused, and the
//     derived status reads `cancelled`.
//
// The real `MediaEnhancementService` over the real tables; only the access port is a stand-in. DB_GATED.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { MediaEnhancementService } from '@marinoscar/memoriahub-api/enhancement';

import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { dropLibraries, newLibrary } from '../helpers/library';
import { rlsBypassPrisma, seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('enhancement batch cancel (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: PrismaService;
  let seed: SeedClient;
  let orgId: string;
  let userId: string;
  const libraries: string[] = [];
  const objects: string[] = [];

  const user = () => ({ id: userId, roles: [], permissions: [], activeOrgId: null });
  const enhancements = () =>
    new MediaEnhancementService(
      service as never,
      { requireOwnerRole: async () => ({ role: 'editor', isSuperAdmin: false }) } as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    service = await rlsBypassPrisma();
    orgId = (await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`)[0]!.id;
    userId = (await prisma.user.create({ data: { email: `enh-cancel-${randomUUID()}@example.test` } })).id;
  }, 60000);

  afterAll(async () => {
    for (const libraryId of libraries) {
      await prisma.job.deleteMany({ where: { type: 'picture_enhancement', subjectId: libraryId } });
      await seed.mediaEnhancement.deleteMany({ where: { circleId: libraryId } });
      await seed.mediaEnhancementBatch.deleteMany({ where: { circleId: libraryId } });
      await seed.mediaItem.deleteMany({ where: { circleId: libraryId } });
      await dropLibraries(prisma, [libraryId]);
    }
    if (objects.length > 0) await seed.storageObject.deleteMany({ where: { id: { in: objects } } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await service?.$disconnect();
    await prisma?.$disconnect();
  });

  async function seedBatch(statuses: Array<'pending' | 'processing' | 'ready'>) {
    const library = await newLibrary(prisma, { ownerId: userId });
    libraries.push(library.id);
    const batch = await seed.mediaEnhancementBatch.create({
      data: { circleId: library.id, requestedCount: statuses.length, queuedCount: statuses.length, source: 'selection', createdById: userId },
      select: { id: true },
    });

    const rows: Array<{ status: string; enhancementId: string; mediaItemId: string; jobId: string }> = [];
    for (const status of statuses) {
      const objectId = randomUUID();
      await seed.$executeRaw`
        INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
        VALUES (${objectId}::uuid, ${orgId}::uuid, 'photo.jpg', 1024, 'image/jpeg', ${`uploads/${objectId}.jpg`}, 's3', 'ready', now())`;
      objects.push(objectId);
      const item = await seed.mediaItem.create({
        data: { storageObjectId: objectId, circleId: library.id, addedById: userId, type: 'photo', source: 'web', originalFilename: 'photo.jpg' },
        select: { id: true },
      });
      const enhancement = await seed.mediaEnhancement.create({
        data: { mediaItemId: item.id, circleId: library.id, batchId: batch.id, status, provider: 'openai', model: 'gpt-image-1', prompt: 'Enhance.', createdById: userId },
        select: { id: true },
      });
      const job = await prisma.job.create({
        data: {
          type: 'picture_enhancement', subjectType: 'media_item', subjectId: library.id, reason: 'rerun', priority: 50,
          status: status === 'pending' ? 'pending' : status === 'processing' ? 'running' : 'succeeded',
          payload: { enhancementId: enhancement.id, circleId: library.id },
        } as never,
        select: { id: true },
      });
      rows.push({ status, enhancementId: enhancement.id, mediaItemId: item.id, jobId: job.id });
    }
    // An unrelated pending enhancement job of the SAME library must survive (matched on the enhancement id, not the library).
    const unrelated = await prisma.job.create({
      data: { type: 'picture_enhancement', subjectType: 'media_item', subjectId: library.id, reason: 'rerun', status: 'pending', payload: { enhancementId: randomUUID(), circleId: library.id } } as never,
      select: { id: true },
    });
    return { libraryId: library.id, batchId: batch.id, rows, unrelatedJobId: unrelated.id };
  }

  it('withdraws the pending rows and their queued jobs, and leaves the processing and ready rows alone', async () => {
    const { batchId, rows, unrelatedJobId } = await seedBatch(['pending', 'pending', 'processing', 'ready']);
    const [p1, p2, proc, ready] = rows as [typeof rows[number], typeof rows[number], typeof rows[number], typeof rows[number]];

    const result = await enhancements().cancelBatch(batchId, user() as never);

    expect(result).toEqual({ batchId, status: 'cancelled', cancelled: 2 });
    const state = Object.fromEntries((await seed.mediaEnhancement.findMany({ where: { batchId }, select: { id: true, status: true } })).map((r) => [r.id, r.status]));
    expect(state).toEqual({
      [p1.enhancementId]: 'cancelled',
      [p2.enhancementId]: 'cancelled',
      [proc.enhancementId]: 'processing',
      [ready.enhancementId]: 'ready',
    });
    const remainingJobs = (await prisma.job.findMany({ where: { id: { in: [p1.jobId, p2.jobId, proc.jobId, ready.jobId, unrelatedJobId] } }, select: { id: true } })).map((j) => j.id);
    expect(remainingJobs.sort()).toEqual([proc.jobId, ready.jobId, unrelatedJobId].sort());
    expect((await seed.mediaEnhancementBatch.findUniqueOrThrow({ where: { id: batchId } })).cancelledAt).not.toBeNull();
  });

  it('reads cancelled once the batch is cancelled, refuses a second cancel, and withdraws nothing from an all-processing batch', async () => {
    const { batchId, rows } = await seedBatch(['processing', 'processing']);

    const first = await enhancements().cancelBatch(batchId, user() as never);

    expect(first.cancelled).toBe(0);
    expect((await seed.mediaEnhancement.findMany({ where: { batchId } })).every((r) => r.status === 'processing')).toBe(true);
    expect(await prisma.job.count({ where: { id: { in: rows.map((r) => r.jobId) } } })).toBe(2);
    await expect(enhancements().cancelBatch(batchId, user() as never)).rejects.toThrow(/already finished/i);
  });
});
