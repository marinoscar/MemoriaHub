/**
 * `export.run` end to end against real PostgreSQL (RETRO-H2, #596).
 *
 * The platform's REAL `ExportRunHandler` and `ExportsService`, constructed by hand over the
 * app's `PrismaService` through `forSystem` (the same bypass `ExportsHostModule` binds through
 * `PrismaSystemService`), and
 * the REAL `ExportsStorageAdapter` over a fake resolver whose providers keep the bytes in
 * memory, keyed by `provider:bucket`. What a mocked Prisma cannot prove:
 *
 *   - each MemoriaHub source reads exactly the caller's rows across the real relations (the
 *     personal circle, what they added in a shared circle) and never another user's personal
 *     circle or someone else's upload in a shared circle;
 *   - no content hash, perceptual hash or storage key value appears in any written file;
 *   - `capturedAt` is the stored UTC wall clock (what the gallery shows), not shifted;
 *   - the file is committed to `storage_objects` with the provider and bucket it went to, the
 *     job payload records the result, and `export.ready` is sent after that commit;
 *   - the download is signed by the RECORDED provider, and another user gets a 404.
 *
 * Needs a database migrated to the latest schema. Skips (reported skipped, never passed)
 * when nothing listens on the port.
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { forSystem } from '@marinoscar/platform-api/core';
import {
  ExportRunHandler,
  ExportsService,
  resolveExportsModuleOptions,
  type ExportsSystemData,
} from '@marinoscar/platform-api/exports';
import { exportFileText } from '@marinoscar/platform-api/exports/testing';
import type { Job } from '@marinoscar/platform-api/jobs';

import '../../src/platform/exports/exports.config';
import { ExportsStorageAdapter } from '../../src/platform/exports/exports-storage.adapter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { defaultOrgId } from '../helpers/default-org';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

/** Stored files, by key, with the location they were written to. */
const stored = new Map<string, { location: string; bytes: Buffer }>();
const signed: string[] = [];
let active = 'local';

function memoryProvider(id: string, bucket: string | null) {
  const location = `${id}:${bucket ?? `${id}-bucket`}`;
  return {
    upload: async (key: string, stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      stored.set(key, { location, bytes: Buffer.concat(chunks) });
      return { key, bucket: `${id}-bucket`, location: `${id}://${key}` };
    },
    getSignedDownloadUrl: async (key: string) => {
      signed.push(`${location}/${key}`);
      return `https://download.example.test/${location}/${key}`;
    },
    delete: async (key: string) => {
      stored.delete(key);
    },
  };
}

const resolver = {
  getActiveProvider: async () => ({ id: active, provider: memoryProvider(active, null) }),
  getProviderFor: async (id: string, bucket?: string | null) => memoryProvider(id, bucket ?? null),
};

describeMaybeDb('export.run with MemoriaHub sources (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let orgId: string;
  let handler: ExportRunHandler;
  let service: ExportsService;
  let storage: ExportsStorageAdapter;
  const notified: { key: string; userId: string; data: Record<string, unknown> }[] = [];
  const options = resolveExportsModuleOptions({ datamodel: Prisma.dmmf.datamodel, appSlug: 'memoriahub' });

  let userA: string;
  let userB: string;
  const marks = {
    personalA: `IMG_A_PERSONAL_${randomUUID().slice(0, 8)}.jpg`,
    sharedByA: `IMG_A_SHARED_${randomUUID().slice(0, 8)}.jpg`,
    sharedByB: `IMG_B_SHARED_${randomUUID().slice(0, 8)}.jpg`,
    personalB: `IMG_B_PERSONAL_${randomUUID().slice(0, 8)}.jpg`,
  };
  const secretValues = {
    contentHash: `contenthash${randomUUID().replace(/-/g, '')}`,
    perceptualHash: '18446744073709551615',
    storageKey: `media/secret-key-${randomUUID()}.jpg`,
  };

  async function user(label: string): Promise<string> {
    return (await prisma.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } })).id;
  }

  async function circle(ownerId: string, isPersonal: boolean, members: string[] = []): Promise<string> {
    const created = await prisma.circle.create({ data: { name: `Circle ${randomUUID().slice(0, 8)}`, ownerId, isPersonal } });
    await prisma.circleMember.create({ data: { circleId: created.id, userId: ownerId, role: 'circle_admin' } });
    for (const userId of members) {
      await prisma.circleMember.create({ data: { circleId: created.id, userId, role: 'collaborator' } });
    }
    return created.id;
  }

  async function media(circleId: string, addedById: string, filename: string, extra: Record<string, unknown> = {}) {
    const object = await prisma.storageObject.create({
      data: {
        name: filename,
        size: BigInt(1234),
        mimeType: 'image/jpeg',
        storageKey: extra.storageKey ? String(extra.storageKey) : `media/${randomUUID()}.jpg`,
        status: 'ready',
        uploadedById: addedById,
        orgId,
      },
    });
    const { storageKey: _ignored, ...columns } = extra;
    return prisma.mediaItem.create({
      data: {
        storageObjectId: object.id,
        circleId,
        addedById,
        type: 'photo',
        source: 'web',
        originalFilename: filename,
        ...columns,
      },
    });
  }

  async function run(source: string, format: string, subjectId: string): Promise<{ id: string; text: string }> {
    const payload = {
      source,
      format,
      request: {},
      requestedById: subjectId,
      scope: 'user',
      subjectId,
      orgId,
      timeZone: 'UTC',
    };
    const row = await prisma.job.create({
      data: {
        type: 'export.run',
        reason: 'rerun',
        subjectType: 'user',
        subjectId,
        status: 'running',
        attempts: 1,
        payload,
        orgId,
      } as never,
    });
    await handler.process({ ...(row as unknown as Job), payload, attempts: 1 });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    const result = (job.payload as { result?: { storageObjectId: string } }).result!;
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: result.storageObjectId } });
    return { id: row.id, text: exportFileText(stored.get(object.storageKey)!.bytes) };
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    orgId = await defaultOrgId(prisma);

    const system: ExportsSystemData = { asSystem: (reason) => forSystem(prisma, reason) as never };
    storage = new ExportsStorageAdapter(resolver as never, { asSystem: (reason: string) => forSystem(prisma, reason as never) } as never);
    handler = new ExportRunHandler(
      { register: () => undefined } as never,
      options,
      prisma as never,
      system,
      storage,
      { record: async () => undefined } as never,
      { notify: async (key: string, userId: string, data: never) => void notified.push({ key, userId, data }) },
    );
    service = new ExportsService(prisma as never, {} as never, storage, system, options);

    userA = await user('person-a');
    userB = await user('person-b');
    const personalA = await circle(userA, true);
    const personalB = await circle(userB, true);
    const shared = await circle(userB, false, [userA]);

    const itemA = await media(personalA, userA, marks.personalA, {
      capturedAt: new Date('2026-06-20T23:30:07.000Z'),
      contentHash: secretValues.contentHash,
      perceptualHash: secretValues.perceptualHash,
      storageKey: secretValues.storageKey,
      geoCanonicalLocality: 'Locality Alpha',
      favorite: true,
    });
    await media(shared, userA, marks.sharedByA);
    await media(shared, userB, marks.sharedByB);
    await media(personalB, userB, marks.personalB);

    const tag = await prisma.tag.create({ data: { circleId: personalA, addedById: userA, name: 'placeholder-tag' } });
    await prisma.mediaTag.create({ data: { tagId: tag.id, mediaItemId: itemA.id } });
    const album = await prisma.album.create({ data: { circleId: personalA, addedById: userA, name: 'Album Alpha' } });
    await prisma.albumItem.create({ data: { albumId: album.id, mediaItemId: itemA.id } });
    await prisma.album.create({ data: { circleId: personalB, addedById: userB, name: 'Album Beta' } });
    const person = await prisma.person.create({ data: { circleId: personalA, addedById: userA, name: 'Person Alpha' } });
    await prisma.face.create({
      data: {
        mediaItemId: itemA.id,
        circleId: personalA,
        personId: person.id,
        boundingBox: { x: 0, y: 0, w: 1, h: 1 },
        embedding: [0.123456789, 0.987654321],
        providerKey: 'test',
        modelVersion: 'v1',
      },
    });
    await prisma.person.create({ data: { circleId: personalB, addedById: userB, name: 'Person Beta' } });

    const memoryBase = {
      periodKey: '2026-06-20',
      titleSource: 'template',
      periodStart: new Date('2026-06-20T00:00:00.000Z'),
      periodEnd: new Date('2026-06-21T00:00:00.000Z'),
      itemCount: 1,
      generatedAt: new Date(),
      refreshedAt: new Date(),
    };
    const memory = await prisma.memory.create({
      data: { ...memoryBase, circleId: personalA, type: 'trip', title: 'Memory Alpha' },
    });
    await prisma.memoryItem.create({ data: { memoryId: memory.id, mediaItemId: itemA.id, position: 0 } });
    await prisma.memoryUserState.create({ data: { memoryId: memory.id, userId: userA, favoritedAt: new Date() } });
    await prisma.memory.create({
      data: { ...memoryBase, circleId: personalA, type: 'seasonal', title: 'Memory Tombstoned', deletedAt: new Date() },
    });
    await prisma.memory.create({ data: { ...memoryBase, circleId: personalB, type: 'trip', title: 'Memory Beta' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(['json', 'csv', 'xlsx'])('exports only the caller’s media, with no hash or key, as %s', async (format) => {
    const { text } = await run('memoriahub-media', format, userA);
    expect(text).toContain(marks.personalA);
    expect(text).toContain(marks.sharedByA);
    expect(text).not.toContain(marks.sharedByB);
    expect(text).not.toContain(marks.personalB);
    for (const value of Object.values(secretValues)) expect(text).not.toContain(value);
    expect(text).toContain('2026-06-20T23:30:07');
    expect(text).not.toContain('2026-06-20T23:30:07.000Z');
    expect(text).toContain('placeholder-tag');
    expect(text).toContain('Person Alpha');
    expect(text).toContain('Album Alpha');
    expect(text).toContain('Locality Alpha');
  });

  it('exports the caller’s albums, live memories and people, never another user’s, nor a face embedding', async () => {
    const albums = await run('memoriahub-albums', 'json', userA);
    expect(albums.text).toContain('Album Alpha');
    expect(albums.text).not.toContain('Album Beta');

    const memories = await run('memoriahub-memories', 'json', userA);
    expect(memories.text).toContain('Memory Alpha');
    expect(memories.text).not.toContain('Memory Tombstoned');
    expect(memories.text).not.toContain('Memory Beta');

    const people = await run('memoriahub-people', 'json', userA);
    const file = JSON.parse(people.text) as { datasets: { person: { rows: { name: string; faceCount: number }[] } } };
    expect(file.datasets.person.rows).toEqual([expect.objectContaining({ name: 'Person Alpha', faceCount: 1 })]);
    expect(people.text).not.toContain('Person Beta');
    expect(people.text).not.toContain('0.123456789');
  });

  it('runs user-data over MemoriaHub’s datamodel without storage keys', async () => {
    const { text } = await run('user-data', 'json', userA);
    expect(text).toContain('"account"');
    // The files list keeps the name, never the object key, bucket or processing metadata.
    expect(text).toContain(marks.personalA);
    expect(text).not.toContain(secretValues.storageKey);
    expect(text).not.toContain('"storageKey"');
    expect(text).not.toContain('"avatarStorageKey"');
  });

  it('commits the file where it was written, notifies after the commit, and signs through the recorded provider', async () => {
    active = 's3';
    notified.length = 0;
    const { id } = await run('memoriahub-albums', 'csv', userA);
    const job = await prisma.job.findUniqueOrThrow({ where: { id } });
    const result = (job.payload as { result: { storageObjectId: string; expiresAt: string } }).result;
    const object = await prisma.storageObject.findUniqueOrThrow({ where: { id: result.storageObjectId } });
    expect(object.storageKey.startsWith('exports/')).toBe(true);
    expect(object.storageProvider).toBe('s3');
    expect(object.bucket).toBe('s3-bucket');
    await new Promise((resolve) => setImmediate(resolve));
    expect(notified).toEqual([
      expect.objectContaining({ key: 'export.ready', userId: userA, data: expect.objectContaining({ exportId: id }) }),
    ]);

    await prisma.job.update({ where: { id }, data: { status: 'succeeded', finishedAt: new Date() } });
    active = 'local';
    const view = await service.get({ id: userA, permissions: ['media:read'], activeOrgId: orgId }, id);
    expect(view.download?.url).toContain(`s3:s3-bucket/${object.storageKey}`);
    expect(signed.at(-1)).toBe(`s3:s3-bucket/${object.storageKey}`);

    await expect(service.get({ id: userB, permissions: ['media:read'], activeOrgId: orgId }, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
