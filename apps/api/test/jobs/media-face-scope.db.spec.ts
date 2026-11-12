/**
 * Real-Postgres tier (RETRO-C3, #585): the `thumbnail_regen` node persist path
 * writes `storage_objects` inside the platform `JobScope`.
 *
 * `ThumbnailNodePersistService.persistThumbnail` runs its two `storage_objects`
 * writes (the thumbnail row upsert and the original's `_processing.thumbnail`
 * merge) in the write scope the handler passes: `jobWriteScope(jobScope, job)`,
 * one transaction whose first statement sets `app.org_id` to the job's
 * organization. This proves, on a real database, that the transaction carries
 * the organization, that both rows are written in it, and that a job with no
 * organization falls back to the plain client (the RETRO-D1 shim).
 *
 * The media item lookup and the storage provider are doubles: only the scoped
 * writes are under test. Skips when no database is reachable.
 */
import { randomUUID } from 'node:crypto';
import { JobScope } from '@marinoscar/platform-api/jobs';
import type { Prisma } from '@prisma/client';

import { ThumbnailNodePersistService } from '@marinoscar/memoriahub-api/media';
import { jobWriteScope } from '../../src/platform/jobs/media-item-job';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { mediaItemJob } from '../helpers/platform-job';
import { seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('thumbnail persist under JobScope (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let seed: SeedClient;
  let orgId: string;
  const created: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    const org = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`;
    if (org.length === 0) throw new Error('no organization row: run the migrations first');
    orgId = org[0]!.id;
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM storage_objects WHERE id::text = ANY($1) OR metadata->>'thumbnailOf' = ANY($1)`,
        created,
      );
    }
    await prisma.$disconnect();
  });

  async function originalObject(): Promise<string> {
    const id = randomUUID();
    await seed.$executeRaw`
      INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, metadata, updated_at)
      VALUES (${id}::uuid, ${orgId}::uuid, 'photo.jpg', 1024, 'image/jpeg', ${`uploads/${id}.jpg`}, 's3', 'ready',
              '{"_processing":{"exif":{"width":10}}}'::jsonb, now())`;
    created.push(id);
    return id;
  }

  function service(objectId: string): ThumbnailNodePersistService {
    // Real client for the scoped writes; the media item lookup is a double.
    const prismaWithItem = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'mediaItem') {
          return {
            findUnique: async () => ({
              id: 'media-1',
              deletedAt: null,
              storageObject: { id: objectId, name: 'photo.jpg', uploadedById: null, metadata: null, orgId },
            }),
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const provider = { exists: async () => true, size: async () => 2048, getBucket: () => 'bucket' };
    return new ThumbnailNodePersistService(
      prismaWithItem as never,
      { active: async () => ({ id: 's3', store: provider }) } as never,
      { syncFromStorageObject: async () => undefined } as never,
      { pruneSupersededThumbnails: async () => undefined } as never,
    );
  }

  it('writes both rows in one transaction that carries the job organization', async () => {
    const objectId = await originalObject();
    const job = mediaItemJob('thumbnail_regen', 'media-1', 'circle-1', { orgId });
    const scope = jobWriteScope(new JobScope(prisma as never), job, prisma as never);
    let seenOrg: string | null = null;
    const observed = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) =>
      scope(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ org: string | null }>>`SELECT current_setting('app.org_id', true) AS org`;
        seenOrg = rows[0]?.org ?? null;
        return fn(tx);
      });
    const storageKey = `thumbnails/${objectId}-0123456789abcdef.jpg`;

    await service(objectId).persistThumbnail(
      { id: job.id, mediaItemId: 'media-1', circleId: 'circle-1' },
      { storageKey, width: 400, height: 300, bytes: 2048 },
      observed as never,
    );

    expect(seenOrg).toBe(orgId);
    const thumb = await seed.storageObject.findUnique({ where: { storageKey } });
    expect(thumb).toMatchObject({ orgId, status: 'ready', mimeType: 'image/jpeg' });
    const original = await seed.storageObject.findUnique({ where: { id: objectId } });
    const meta = original!.metadata as { _processing: Record<string, unknown> };
    // The merge kept the existing entry and added the thumbnail.
    expect(meta._processing['exif']).toEqual({ width: 10 });
    expect(meta._processing['thumbnail']).toEqual({ thumbnailObjectId: thumb!.id, thumbnailStorageKey: storageKey });
  });

  it('a job with no organization runs in the default organization (RETRO-D1)', async () => {
    const objectId = await originalObject();
    const job = mediaItemJob('thumbnail_regen', 'media-1', 'circle-1', { orgId: null });
    const scope = jobWriteScope(new JobScope(prisma as never), job, prisma as never);
    let seenOrg: string | null = null;
    const observed = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) =>
      scope(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ org: string | null }>>`SELECT current_setting('app.org_id', true) AS org`;
        seenOrg = rows[0]?.org ?? null;
        return fn(tx);
      });
    const storageKey = `thumbnails/${objectId}-fedcba9876543210.jpg`;

    await service(objectId).persistThumbnail(
      { id: job.id, mediaItemId: 'media-1', circleId: 'circle-1' },
      { storageKey, width: 400, height: 300, bytes: 2048 },
      observed as never,
    );
    expect(seenOrg).toBe(orgId);

    await expect(seed.storageObject.findUnique({ where: { storageKey } })).resolves.toMatchObject({ orgId });
  });
});
