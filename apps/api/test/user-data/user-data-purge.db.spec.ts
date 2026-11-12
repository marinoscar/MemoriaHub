/**
 * The user-data slice against real PostgreSQL (RETRO-H1, #591).
 *
 * A mocked Prisma cannot prove what this feature is about: that the platform's
 * relation-ordered purge, MemoriaHub's delegated jobs, the user removal hook and
 * the factory reset steps delete exactly the rows they should across the real
 * foreign keys (`Restrict` on `circles.owner_id` and the four `added_by_id`
 * keys, the cascades from media items and circles), and that every stored file
 * is deleted through the provider recorded on its row.
 *
 * The platform pieces are the REAL ones (`UserPurgeRunner`, `FactoryResetHandler`,
 * `UserDataPlanService` over the composed schema), constructed by hand with a
 * fake job queue, audit sink and storage providers that record every key they
 * are asked to delete, keyed by `provider:bucket`.
 *
 * Destructive: the factory reset case wipes the database. Needs a database
 * migrated to the latest schema (`npm run prisma:migrate`); run this file on its
 * own. Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { deleteGrantsForResources } from '@marinoscar/platform-api/sharing';
import { forSystem, runAsSystem } from '@marinoscar/platform-api/core';
import {
  FactoryResetHandler,
  UserDataPlanService,
  UserPurgeRunner,
  composedSchemaDatamodel,
  resolveUserDataModuleOptions,
  type UserDataDbPort,
} from '@marinoscar/platform-api/user-data';

import '../../src/platform/user-data/user-data.manifest';
import { bindMemoriaHubFactoryResetDeps } from '../../src/platform/user-data/factory-reset.steps';
import { CirclePurgeHandler, MEMORIAHUB_PURGE_JOB_TYPES } from '../../src/platform/user-data/memoriahub-purge.handlers';
import {
  MemoriaHubUserDataService,
  SharedCircleOwnershipError,
} from '../../src/platform/user-data/memoriahub-user-data.service';
import { memoriaHubCircleContentRemovalHook } from '../../src/platform/user-data/user-removal.hook';
import { MediaService } from '@marinoscar/memoriahub-api/media';
import { PrismaService } from '../../src/prisma/prisma.service';
import { newLibrary } from '../helpers/library';
import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { sqlScopeDirectory } from '../helpers/scope-directory';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

/** Every key a fake provider was asked to delete, by `provider:bucket`. */
const deletedKeys = new Map<string, string[]>();

function fakeProvider(id: string, bucket: string | null) {
  const group = `${id}:${bucket ?? ''}`;
  return {
    deleteMany: async (keys: string[]) => {
      deletedKeys.set(group, [...(deletedKeys.get(group) ?? []), ...keys]);
      return { deleted: [...keys], failed: [] }; // the platform StorageDeleteManyResult (next.28)
    },
    delete: async (key: string) => {
      deletedKeys.set(group, [...(deletedKeys.get(group) ?? []), key]);
    },
    abortMultipartUpload: async () => undefined,
  };
}

const resolver = { getProviderFor: async (id: string, bucket?: string | null) => fakeProvider(id, bucket ?? null) };
const allDeleted = () => [...deletedKeys.values()].flat();

describeMaybeDb('user-data purge, removal hook and factory reset (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let seed: SeedClient;
  let service: MemoriaHubUserDataService;
  let orgId: string;
  const enqueued: { type: string; payload: Record<string, unknown> }[] = [];

  async function user(label: string): Promise<string> {
    return (await prisma.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } })).id;
  }

  async function circle(ownerId: string, isPersonal: boolean, members: string[] = []): Promise<string> {
    // A shared library is a group, a personal one a personal_libraries row (RETRO-K2).
    return (
      await newLibrary(prisma, { ownerId, personal: isPersonal, members: members.map((userId) => ({ userId, role: 'editor' as const })) })
    ).id;
  }

  async function object(uploadedById: string, storageKey: string, provider = 's3', bucket: string | null = 'bucket-a') {
    return seed.storageObject.create({
      data: {
        orgId,
        name: storageKey,
        size: BigInt(10),
        mimeType: 'image/jpeg',
        storageKey,
        storageProvider: provider,
        bucket,
        status: 'ready',
        uploadedById,
      },
    });
  }

  /** A photo with its original, a thumbnail object and a face. */
  async function photo(circleId: string, addedById: string, provider = 's3', bucket: string | null = 'bucket-a') {
    const original = await object(addedById, `originals/${randomUUID()}.jpg`, provider, bucket);
    const thumb = await object(addedById, `thumbnails/${original.id}-abcdef0123456789.jpg`, provider, bucket);
    const item = await seed.mediaItem.create({
      data: {
        storageObjectId: original.id,
        circleId,
        addedById,
        type: 'photo',
        source: 'web',
        originalFilename: 'photo.jpg',
      },
    });
    await seed.face.create({
      data: {
        mediaItemId: item.id,
        circleId,
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        providerKey: 'compreface',
        modelVersion: 'test',
        embedding: [],
      },
    });
    return { item, original, thumb };
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    const org = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
    orgId = org!.id;

    // The real batched media purge; only its storage resolver is faked.
    const media = Object.create(MediaService.prototype) as MediaService;
    const objectStore = {
      forLocation: (provider: string | null | undefined, bucket?: string | null) => resolver.getProviderFor(provider as string, bucket),
    };
    // The grants of a purged item go with its row (the access port of the app, minus its scope data).
    const access = { deleteGrantsFor: (tx: unknown, type: 'media_item' | 'album', ids: readonly string[]) => deleteGrantsForResources(tx, type, ids) };
    Object.assign(media, { prisma: forSystem(prisma, 'purge' as never), objectStore, access, logger: new Logger('MediaService') });
    // The system client over the app's client (PrismaSystemService.asSystem in the app).
    const system = { asSystem: (reason: string) => forSystem(prisma, reason as never) };
    // The purge and the removal hook read and delete rows of every organization table, on the client they
    // are given, with no organization of their own (the app-reads row of docs/platform-adoption/
    // local-exceptions.md). Under the ordinary role the spec hands them the platform's system client, the
    // same `asSystem('purge')` bypass the service already uses for `storage_objects`: an explicit, reasoned
    // bypass, never a superuser connection.
    const purgeClient = forSystem(prisma, 'purge' as never) as unknown as PrismaService;
    service = new MemoriaHubUserDataService(
      purgeClient,
      media,
      resolver as never,
      system as never,
      sqlScopeDirectory(prisma) as never,
      new PersonalLibraryStore(prisma),
    );
    bindMemoriaHubFactoryResetDeps({ service });
  });

  beforeEach(() => {
    deletedKeys.clear();
    enqueued.length = 0;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  const db = (): UserDataDbPort => ({
    runAsSystem: (reason, fn, options) => runAsSystem(prisma as never, reason, fn as never, options) as never,
    system: (reason) => forSystem(prisma, reason),
  });

  function platform() {
    const options = resolveUserDataModuleOptions({
      datamodel: composedSchemaDatamodel(__dirname),
      userRemovalHooks: [memoriaHubCircleContentRemovalHook],
      factoryReset: { keepJobsReferencedBy: [{ model: 'DatabaseBackupRun', field: 'jobId' }] },
      txTimeoutMs: 120_000,
    });
    const plans = new UserDataPlanService(options);
    const jobs = {
      enqueue: async (input: { type: string; payload: Record<string, unknown> }) => {
        enqueued.push(input);
        return { id: randomUUID() };
      },
    };
    const audit = { record: async () => undefined };
    const moduleRef = { get: () => service };
    const storage = fakeProvider('platform-active', null);
    const runner = new UserPurgeRunner(db(), storage as never, plans, jobs as never, audit as never, options, moduleRef as never);
    const handler = new FactoryResetHandler({} as never, db(), storage as never, plans, runner, audit as never, options);
    return { plans, runner, handler };
  }

  async function jobRow(type: string, payload: Record<string, unknown>) {
    return prisma.job.create({
      data: { id: randomUUID(), type, status: 'running', reason: 'rerun', priority: 0, payload } as never,
    });
  }

  it('the plan exists for the composed schema and no model is the platform storage-object purge', () => {
    const { plans } = platform();
    const plan = plans.user();
    expect(plan.storage).toBeUndefined();
    expect(plan.delegated.map((step) => step.model).sort()).toEqual(['MediaSyncDevice', 'StorageObject', 'UserProfile']);
    expect(plan.steps.map((step) => step.model)).toEqual(
      expect.arrayContaining(['MemoryUserState', 'MhLegacyNotification']),
    );
  });

  it('a Danger Zone "everything" purge empties the personal circle and keeps shared-circle content', async () => {
    const alpha = await user('person-a');
    const beta = await user('person-b');
    const personal = await circle(alpha, true);
    const shared = await circle(beta, false, [alpha]);

    const mine = await photo(personal, alpha, 's3', 'bucket-a');
    const minePrivate = await photo(personal, alpha, 'r2', 'bucket-r2');
    const contributed = await photo(shared, alpha, 's3', 'bucket-a');
    await seed.album.create({ data: { circleId: personal, addedById: alpha, name: 'Album Alpha' } });
    await seed.tag.create({ data: { circleId: personal, addedById: alpha, name: 'tag-alpha' } });
    await seed.person.create({ data: { circleId: personal, addedById: alpha, name: 'Person C' } });
    const sharedAlbum = await seed.album.create({ data: { circleId: shared, addedById: alpha, name: 'Album Beta' } });

    const { runner } = platform();
    const job = await jobRow('user.data.purge', { userId: alpha, scope: 'everything' });
    await runner.runJob(job as never, { userId: alpha, scope: 'everything' });

    // Public links are link grants since RETRO-I4: they belong to the record's owner and are kept.
    // Delegated, once each.
    expect(enqueued.map((input) => input.type).sort()).toEqual(
      [MEMORIAHUB_PURGE_JOB_TYPES.DEVICES, MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE, MEMORIAHUB_PURGE_JOB_TYPES.PROFILE].sort(),
    );
    // The platform never deleted a stored file through its own (active) provider.
    expect(deletedKeys.get('platform-active:')).toBeUndefined();

    const handler = new CirclePurgeHandler({ register: () => undefined } as never, service);
    const circleJob = enqueued.find((input) => input.type === MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE)!;
    await handler.process({ id: randomUUID(), type: circleJob.type, payload: circleJob.payload } as never);

    // Personal circle emptied (the circle itself stays), files deleted through their own provider.
    expect(await seed.mediaItem.count({ where: { circleId: personal } })).toBe(0);
    expect(await seed.album.count({ where: { circleId: personal } })).toBe(0);
    expect(await seed.tag.count({ where: { circleId: personal } })).toBe(0);
    expect(await seed.person.count({ where: { circleId: personal } })).toBe(0);
    expect(await seed.face.count({ where: { circleId: personal } })).toBe(0);
    expect(await prisma.personalLibrary.count({ where: { id: personal } })).toBe(1);
    expect(deletedKeys.get('s3:bucket-a')).toEqual(
      expect.arrayContaining([mine.original.storageKey, mine.thumb.storageKey]),
    );
    expect(deletedKeys.get('r2:bucket-r2')).toEqual(
      expect.arrayContaining([minePrivate.original.storageKey, minePrivate.thumb.storageKey]),
    );
    expect(
      await seed.storageObject.count({ where: { id: { in: [mine.original.id, mine.thumb.id, minePrivate.original.id] } } }),
    ).toBe(0);

    // What alpha added to beta's circle stays, with its file.
    expect(await seed.mediaItem.count({ where: { id: contributed.item.id, addedById: alpha } })).toBe(1);
    expect(await seed.album.count({ where: { id: sharedAlbum.id } })).toBe(1);
    expect(allDeleted()).not.toContain(contributed.original.storageKey);
    expect(await seed.storageObject.count({ where: { id: contributed.original.id } })).toBe(1);
  });

  it('the removal hook refuses while the user owns a shared circle with other members, changing nothing', async () => {
    const alpha = await user('owner-a');
    const beta = await user('member-b');
    const owned = await circle(alpha, false, [beta]);
    const kept = await photo(owned, beta);

    await expect(service.prepareUserRemoval(alpha)).rejects.toBeInstanceOf(SharedCircleOwnershipError);
    await expect(service.prepareUserRemoval(alpha)).rejects.toThrow(/Transfer ownership/);
    expect(await seed.group.count({ where: { id: owned } })).toBe(1);
    expect(await seed.mediaItem.count({ where: { id: kept.item.id } })).toBe(1);
  });

  it('the removal hook deletes the user\'s own circles, reassigns shared content, and the user row can go', async () => {
    const alpha = await user('leaver-a');
    const beta = await user('owner-b');
    const personal = await circle(alpha, true);
    const solo = await circle(alpha, false); // shared with nobody
    const shared = await circle(beta, false, [alpha]);
    const mine = await photo(personal, alpha);
    await photo(solo, alpha);
    const contributed = await photo(shared, alpha);
    const album = await seed.album.create({ data: { circleId: shared, addedById: alpha, name: 'Album Gamma' } });
    const tag = await seed.tag.create({ data: { circleId: shared, addedById: alpha, name: 'tag-gamma' } });
    const person = await seed.person.create({ data: { circleId: shared, addedById: alpha, name: 'Person D' } });

    const counts = await service.prepareUserRemoval(alpha);
    expect(counts.circlesDeleted).toBe(2);
    expect(counts.mediaReassigned).toBe(1);

    expect(await prisma.personalLibrary.count({ where: { id: personal } })).toBe(0);
    expect(await seed.group.count({ where: { id: solo } })).toBe(0);
    expect(allDeleted()).toContain(mine.original.storageKey);
    expect((await seed.mediaItem.findUnique({ where: { id: contributed.item.id } }))?.addedById).toBe(beta);
    expect((await seed.album.findUnique({ where: { id: album.id } }))?.addedById).toBe(beta);
    expect((await seed.tag.findUnique({ where: { id: tag.id } }))?.addedById).toBe(beta);
    expect((await seed.person.findUnique({ where: { id: person.id } }))?.addedById).toBe(beta);

    // No Restrict key names the user any more: the row deletes without a foreign-key error.
    await expect(prisma.user.delete({ where: { id: alpha } })).resolves.toBeDefined();
    expect(await seed.mediaItem.count({ where: { id: contributed.item.id } })).toBe(1);
  });

  it('a factory reset deletes every domain row and file but the kept list, and leaves the actor a personal circle', async () => {
    const actor = await user('admin-a');
    const other = await user('member-b');
    await circle(actor, true);
    const otherPersonal = await circle(other, true);
    const shared = await circle(other, false, [actor]);
    const otherPhoto = await photo(otherPersonal, other, 'r2', 'bucket-r2');
    const actorPhoto = await photo(shared, actor);
    await seed.album.create({ data: { circleId: shared, addedById: other, name: 'Album Delta' } });
    await prisma.tagLabel.create({ data: { name: `label-${randomUUID()}` } });
    const backupObject = await object(actor, `database-backups/memoriahub/2026/11/${randomUUID()}.dump`);
    const labelsBefore = await prisma.tagLabel.count();
    const sharedDevice = await prisma.mediaSyncDevice.create({
      data: { userId: other, installationId: randomUUID(), name: 'Phone A', config: {} },
    } as never);

    const { handler } = platform();
    const job = await jobRow('admin.factory_reset', { actorUserId: actor });
    await handler.process(job as never);

    expect(await prisma.user.count()).toBe(1);
    expect(await seed.mediaItem.count()).toBe(0);
    expect(await seed.album.count()).toBe(0);
    expect(await seed.tag.count()).toBe(0);
    expect(await seed.person.count()).toBe(0);
    expect(await seed.face.count()).toBe(0);
    expect(await prisma.mediaSyncDevice.count({ where: { id: sharedDevice.id } })).toBe(0);
    // The first-run state: exactly the actor's own personal library (the other users' left with them,
    // and so did the group they were the last members of).
    const libraries = await prisma.personalLibrary.findMany({ select: { userId: true } });
    expect(libraries).toEqual([{ userId: actor }]);
    expect(await seed.group.count()).toBe(0);
    // Kept: configuration (the tag vocabulary) and backups (their files are never swept).
    expect(await prisma.tagLabel.count()).toBe(labelsBefore);
    expect(await seed.storageObject.count({ where: { id: backupObject.id } })).toBe(1);
    expect(await seed.storageObject.count({ where: { NOT: { storageKey: { startsWith: 'database-backups/' } } } })).toBe(0);
    expect(allDeleted()).not.toContain(backupObject.storageKey);
    // Files went through the provider recorded on each row.
    // (Earlier cases leave shared-circle content behind, which the reset sweeps too.)
    expect(deletedKeys.get('r2:bucket-r2')).toEqual(
      expect.arrayContaining([otherPhoto.original.storageKey, otherPhoto.thumb.storageKey]),
    );
    expect(deletedKeys.get('s3:bucket-a')).toEqual(
      expect.arrayContaining([actorPhoto.original.storageKey, actorPhoto.thumb.storageKey]),
    );
  });
});
