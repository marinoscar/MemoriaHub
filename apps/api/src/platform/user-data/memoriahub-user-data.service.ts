import { Injectable, Logger } from '@nestjs/common';

import { MediaService } from '../../media/media.service';
import { OwnerScopeSweepService } from '../sharing/owner-scope-sweep.service';
import { PersonalLibraryStore } from '../sharing/personal-library.store';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { deleteStorageKeys } from '@marinoscar/platform-api/storage';
import { deleteGrantsForResources } from '@marinoscar/platform-api/sharing';

import { StorageProviderResolver } from '../storage/storage-provider.resolver';

// =============================================================================
// MemoriaHub's own data deletions (RETRO-H1, #591)
// =============================================================================
//
// The work the platform user-data slice cannot do from the Prisma schema alone,
// because it depends on MemoriaHub's circles:
//
//   - the delegated purges (`memoriahub-purge.handlers.ts`): the user's PERSONAL
//     circle emptied (photos, videos, albums, tags, people and faces, memories,
//     workflows, with every stored file), the paired phones and their tokens, the
//     profile picture;
//   - the user removal hook (`user-removal.hook.ts`): a user ROW about to be
//     deleted (offboarding with `userDisposition: 'purge'`) loses their own
//     circles, the content they added to other people's circles is reassigned to
//     each circle's owner, and owning a shared circle with other members refuses
//     the removal;
//   - the factory reset's MemoriaHub steps (`factory-reset.steps.ts`).
//
// STORAGE IS ROUTED PER ROW. Every stored file is deleted through the provider
// and bucket recorded on its own row (`storage_objects.storage_provider` /
// `bucket`, `media_enhancements.staging_provider` / `staging_bucket`), never the
// active provider: an object written before an admin switched providers lives
// where it was written. Bytes go first, then the row; a provider failure keeps
// the row (it is counted and logged with its id, never its key) so a retry finds
// it again. Media rows go through `MediaService.purgeMediaItemsBatched`, the
// same batched path the trash uses.
//
// RETRY SAFETY. Every delete is by predicate, so a re-run deletes what is left;
// nothing here keeps state between calls.
// =============================================================================

/** Media items purged per page. */
export const MEDIA_PURGE_PAGE = 500;

/** Storage-object rows deleted per page. */
export const STORAGE_PURGE_PAGE = 1000;

/**
 * Key prefixes the factory reset's storage sweep never touches, on top of the
 * storage key-prefix registry's `survivesFactoryReset` ones (which the db-backup
 * slice and `app-registrations/db-backup.ts` fill when they are loaded): the
 * database backups, current (`database-backups/`) and legacy (`db-backups/`), and
 * the legacy Android releases (`android-releases/`, written outside
 * `storage_objects`, listed for safety). Spelled out so the sweep can never
 * depend on import order to keep a backup.
 */
export const MEMORIAHUB_SURVIVING_PREFIXES = ['database-backups/', 'db-backups/', 'android-releases/'] as const;

/** A storage-object row with what is needed to delete its bytes. */
export interface StoredObjectRow {
  id: string;
  storageKey: string;
  storageProvider: string;
  bucket: string | null;
}

/** Counts of one operation, by name. */
export type Counts = Record<string, number>;

/** Thrown by the removal hook when a user still owns a circle other people use. */
export class SharedCircleOwnershipError extends Error {
  constructor(
    readonly userId: string,
    readonly circleIds: readonly string[],
  ) {
    super(
      `user ${userId} owns ${circleIds.length} shared circle(s) with other members ` +
        `(${circleIds.join(', ')}). Transfer ownership of each circle to another member, ` +
        'or remove its other members, before the account can be deleted.',
    );
    this.name = 'SharedCircleOwnershipError';
  }
}

const STORED_OBJECT_SELECT = { id: true, storageKey: true, storageProvider: true, bucket: true } as const;

@Injectable()
export class MemoriaHubUserDataService {
  private readonly logger = new Logger(MemoriaHubUserDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly resolver: StorageProviderResolver,
    private readonly system: PrismaSystemService,
    private readonly scopes: OwnerScopeSweepService,
    private readonly personalLibraries: PersonalLibraryStore,
  ) {}

  /** `storage_objects` is an organization table with row-level security; a purge must see every row. */
  private storageClient(): PrismaService {
    return this.system.asSystem('purge') as unknown as PrismaService;
  }

  // ---------------------------------------------------------------------------
  // Circles
  // ---------------------------------------------------------------------------

  /** The user's personal circle(s): normally exactly one. */
  async personalCircleIds(userId: string): Promise<string[]> {
    const id = await this.personalLibraries.idOf(userId);
    return id ? [id] : [];
  }

  // ---------------------------------------------------------------------------
  // Storage, routed per row
  // ---------------------------------------------------------------------------

  /**
   * Deletes stored objects: bytes through each row's own provider and bucket,
   * then the rows whose bytes went. Never throws on a provider failure.
   */
  async deleteStoredObjects(rows: readonly StoredObjectRow[]): Promise<{ deleted: number; failed: number }> {
    if (rows.length === 0) return { deleted: 0, failed: 0 };
    const groups = new Map<string, { provider: string; bucket: string | null; rows: StoredObjectRow[] }>();
    for (const row of rows) {
      const key = `${row.storageProvider}\u0000${row.bucket ?? ''}`;
      const group = groups.get(key) ?? { provider: row.storageProvider, bucket: row.bucket, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    const gone: string[] = [];
    let failed = 0;
    for (const group of groups.values()) {
      try {
        const provider = await this.resolver.getProviderFor(group.provider, group.bucket);
        const result = await deleteStorageKeys(provider, group.rows.map((row) => row.storageKey));
        const failedKeys = new Set(result.failed.map((error) => error.key));
        for (const row of group.rows) {
          if (failedKeys.has(row.storageKey)) {
            failed += 1;
            this.logger.warn(`storage object ${row.id} kept: the provider refused its deletion`);
          } else {
            gone.push(row.id);
          }
        }
      } catch (err) {
        failed += group.rows.length;
        this.logger.warn(
          `${group.rows.length} storage object(s) kept: provider ${group.provider} could not be reached (${describe(err)})`,
        );
      }
    }

    let deleted = 0;
    const client = this.storageClient();
    for (const ids of chunk(gone, STORAGE_PURGE_PAGE)) {
      deleted += (await client.storageObject.deleteMany({ where: { id: { in: ids } } })).count;
    }
    return { deleted, failed };
  }

  /** The derived objects of media items: their thumbnails (every version) and video face frames. */
  private async derivedObjectsOf(items: readonly { id: string; storageObjectId: string }[]): Promise<StoredObjectRow[]> {
    if (items.length === 0) return [];
    const or = [
      ...items.map((item) => ({ storageKey: { startsWith: `thumbnails/${item.storageObjectId}` } })),
      ...items.map((item) => ({ storageKey: { startsWith: `video-faces/${item.id}/` } })),
    ];
    return this.storageClient().storageObject.findMany({ where: { OR: or }, select: STORED_OBJECT_SELECT });
  }

  /** Staged AI-enhancement results have no storage-object row: deleted through their recorded provider. */
  async deleteEnhancementStaging(where: Record<string, unknown>): Promise<Counts> {
    const rows = await this.prisma.mediaEnhancement.findMany({
      where: { ...where, OR: [{ stagingStorageKey: { not: null } }, { stagingThumbnailKey: { not: null } }] },
      select: { id: true, stagingStorageKey: true, stagingThumbnailKey: true, stagingProvider: true, stagingBucket: true },
    });
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      const keys = [row.stagingStorageKey, row.stagingThumbnailKey].filter((key): key is string => !!key);
      if (!row.stagingProvider) {
        // A staging row without a recorded provider predates the column; nothing to route by.
        failed += keys.length;
        continue;
      }
      try {
        const provider = await this.resolver.getProviderFor(row.stagingProvider, row.stagingBucket);
        const result = await deleteStorageKeys(provider, keys);
        deleted += result.deleted.length;
        failed += result.failed.length;
      } catch (err) {
        failed += keys.length;
        this.logger.warn(`enhancement ${row.id}: staged files kept (${describe(err)})`);
      }
    }
    if (rows.length > 0) {
      await this.prisma.mediaEnhancement.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { stagingStorageKey: null, stagingThumbnailKey: null },
      });
    }
    return { stagingFilesDeleted: deleted, stagingFilesFailed: failed };
  }

  // ---------------------------------------------------------------------------
  // Media of whole circles
  // ---------------------------------------------------------------------------

  /**
   * Hard-deletes every media item of the circles, with its original, thumbnails,
   * video face frames and staged enhancements, then the circles' tags, memories
   * and review groups (all derived from the media). Paged; retry-safe.
   */
  async purgeCircleMedia(circleIds: readonly string[]): Promise<Counts> {
    const counts: Counts = { mediaItems: 0, mediaItemsFailed: 0, derivedFilesDeleted: 0, derivedFilesFailed: 0 };
    if (circleIds.length === 0) return counts;
    const failedIds: string[] = [];

    for (;;) {
      const page = await this.prisma.mediaItem.findMany({
        where: { circleId: { in: [...circleIds] }, ...(failedIds.length ? { id: { notIn: failedIds } } : {}) },
        select: { id: true, storageObjectId: true },
        orderBy: { id: 'asc' },
        take: MEDIA_PURGE_PAGE,
      });
      if (page.length === 0) break;
      const ids = page.map((item) => item.id);

      const staging = await this.deleteEnhancementStaging({ mediaItemId: { in: ids } });
      counts.derivedFilesDeleted += staging.stagingFilesDeleted;
      counts.derivedFilesFailed += staging.stagingFilesFailed;
      const derived = await this.derivedObjectsOf(page);

      const result = await this.media.purgeMediaItemsBatched(ids);
      counts.mediaItems += result.deleted;
      counts.mediaItemsFailed += result.failedIds.length;
      failedIds.push(...result.failedIds);

      // Only the derived files of rows that really went.
      const failed = new Set(result.failedIds);
      const keep = new Set(page.filter((item) => failed.has(item.id)).flatMap((item) => [item.id, item.storageObjectId]));
      const removable = derived.filter((row) => ![...keep].some((id) => row.storageKey.includes(id)));
      const files = await this.deleteStoredObjects(removable);
      counts.derivedFilesDeleted += files.deleted;
      counts.derivedFilesFailed += files.failed;
    }

    const where = { circleId: { in: [...circleIds] } };
    counts.tags = (await this.prisma.tag.deleteMany({ where })).count;
    counts.memories = (await this.prisma.memory.deleteMany({ where })).count;
    counts.burstGroups = (await this.prisma.burstGroup.deleteMany({ where })).count;
    counts.duplicateGroups = (await this.prisma.duplicateGroup.deleteMany({ where })).count;
    if (counts.mediaItemsFailed > 0) {
      this.logger.warn(`${counts.mediaItemsFailed} media item(s) could not be deleted and were kept`);
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // The delegated per-user purges (the user stays)
  // ---------------------------------------------------------------------------

  /**
   * Deletes everything IN the circles but the circles themselves: photos and
   * videos with their files, albums, tags, people and faces, memories and
   * workflows (with their run history).
   */
  async purgeCircleContent(circleIds: readonly string[]): Promise<Counts> {
    if (circleIds.length === 0) return {};
    const media = await this.purgeCircleMedia(circleIds);
    const people = await this.purgeCirclePeople(circleIds);
    const where = { circleId: { in: [...circleIds] } };
    return {
      ...media,
      ...people,
      albums: await this.deleteAlbumsWithGrants(where),
      workflows: (await this.prisma.workflow.deleteMany({ where })).count,
    };
  }

  /**
   * Deletes albums and, in the same transaction, their grants (RETRO-I6, #588):
   * a grant has no foreign key to its polymorphic record.
   */
  private async deleteAlbumsWithGrants(where: { circleId: { in: string[] } }): Promise<number> {
    const ids = (await this.prisma.album.findMany({ where, select: { id: true } })).map((row) => row.id);
    if (ids.length === 0) return 0;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.album.deleteMany({ where: { id: { in: ids } } });
      await deleteGrantsForResources(tx, 'album', ids);
      return count;
    });
  }

  /**
   * `memoriahub.circle.purge`: the user's PERSONAL circle is emptied (the circle
   * itself stays, so the account keeps working). Content the user added to a
   * circle shared with others is not touched.
   */
  async purgePersonalCircle(userId: string): Promise<Counts> {
    return this.purgeCircleContent(await this.personalCircleIds(userId));
  }

  private async purgeCirclePeople(circleIds: readonly string[]): Promise<Counts> {
    const where = { circleId: { in: [...circleIds] } };
    const counts: Counts = { faces: 0, people: 0, faceFramesDeleted: 0, faceFramesFailed: 0 };

    for (;;) {
      const page = await this.prisma.face.findMany({
        where,
        select: { id: true, frameThumbnailKey: true },
        orderBy: { id: 'asc' },
        take: STORAGE_PURGE_PAGE,
      });
      if (page.length === 0) break;
      const keys = page.map((face) => face.frameThumbnailKey).filter((key): key is string => !!key);
      if (keys.length > 0) {
        const frames = await this.storageClient().storageObject.findMany({
          where: { storageKey: { in: keys } },
          select: STORED_OBJECT_SELECT,
        });
        const files = await this.deleteStoredObjects(frames);
        counts.faceFramesDeleted += files.deleted;
        counts.faceFramesFailed += files.failed;
      }
      counts.faces += (await this.prisma.face.deleteMany({ where: { id: { in: page.map((face) => face.id) } } })).count;
    }
    await this.prisma.mediaFaceStatus.deleteMany({ where: { mediaItem: where } });
    counts.people = (await this.prisma.person.deleteMany({ where })).count;
    return counts;
  }

  /**
   * `memoriahub.media_sync.purge`: the user's paired phones (runs and reports
   * cascade) and the personal access token each one signed in with, so an
   * unpaired phone cannot keep uploading.
   */
  async purgeDevices(userId: string): Promise<Counts> {
    const devices = await this.prisma.mediaSyncDevice.findMany({ where: { userId }, select: { id: true, patId: true } });
    const patIds = devices.map((device) => device.patId).filter((id): id is string => !!id);
    const deleted = (await this.prisma.mediaSyncDevice.deleteMany({ where: { userId } })).count;
    const tokens =
      patIds.length > 0
        ? (await this.prisma.personalAccessToken.deleteMany({ where: { id: { in: patIds }, userId } })).count
        : 0;
    return { devices: deleted, deviceTokens: tokens };
  }

  /** `memoriahub.profile.purge`: the profile picture (every stored version) and the person link. */
  async purgeProfile(userId: string): Promise<Counts> {
    const avatars = await this.storageClient().storageObject.findMany({
      where: { storageKey: { startsWith: `avatars/${userId}/` } },
      select: STORED_OBJECT_SELECT,
    });
    const files = await this.deleteStoredObjects(avatars);
    const profiles = (await this.prisma.userProfile.deleteMany({ where: { userId } })).count;
    return { profiles, avatarFilesDeleted: files.deleted, avatarFilesFailed: files.failed };
  }

  // ---------------------------------------------------------------------------
  // The user removal hook (the user row goes next)
  // ---------------------------------------------------------------------------

  /**
   * Prepares a user row for deletion:
   *
   *   1. refuses (throws {@link SharedCircleOwnershipError}, nothing changed) when
   *      the user owns a non-personal circle that has other members;
   *   2. deletes every circle the user owns (personal, or shared with nobody),
   *      with all its content and files;
   *   3. reassigns what the user added to OTHER people's circles (media, albums,
   *      tags, people) to each circle's owner, so it stays for the members.
   *
   * Afterwards no `Restrict` key (`circles.owner_id`, `*.added_by_id`) names the user.
   */
  async prepareUserRemoval(userId: string): Promise<Counts> {
    // The scopes the user owns (RETRO-K1): their personal library, and every group they created.
    const personalId = await this.personalLibraries.idOf(userId);
    const createdGroups = (await this.scopes.allScopes()).filter((scope) => scope.kind === 'group' && scope.createdById === userId);
    const blocking: string[] = [];
    for (const group of createdGroups) {
      const members = await this.scopes.membersOf(group.id);
      if (members.some((member) => member.userId !== userId)) blocking.push(group.id);
    }
    if (blocking.length > 0) throw new SharedCircleOwnershipError(userId, blocking);
    const owned = [...(personalId ? [{ id: personalId }] : []), ...createdGroups.map((group) => ({ id: group.id }))];

    const ownedIds = owned.map((circle) => circle.id);
    const counts: Counts = { circlesDeleted: 0 };
    if (ownedIds.length > 0) {
      Object.assign(counts, await this.purgeCircleContent(ownedIds));
      if (counts.mediaItemsFailed > 0) {
        throw new Error(
          `user ${userId}: ${counts.mediaItemsFailed} media item(s) of their own circles could not be deleted; retry`,
        );
      }
      // PLATFORM-ADOPTION-SHIM(RETRO-K1): until RETRO-K2 drops `circles`, a scope still has a circle row
      // (the mirror triggers delete the group with it); K2 deletes the group / personal library here instead.
      counts.circlesDeleted = (await this.prisma.circle.deleteMany({ where: { id: { in: ownedIds } } })).count;
    }

    const reassigned = await this.reassignSharedContent(userId);
    return { ...counts, ...reassigned };
  }

  /** The user a scope's content is reassigned to: the personal library's owner, else the group's creator, else an admin member. */
  private async contentOwnerOf(scopeId: string, leaving: string): Promise<string | null> {
    const summary = await this.scopes.summary(scopeId);
    if (!summary) return null;
    if (summary.kind === 'personal') return summary.ownerId;
    if (summary.createdById && summary.createdById !== leaving) return summary.createdById;
    const admins = await this.scopes.membersOf(scopeId, ['admin']);
    return admins.find((member) => member.userId !== leaving)?.userId ?? null;
  }

  /** Every row the user added to a circle they do not own now names that circle's owner. */
  private async reassignSharedContent(userId: string): Promise<Counts> {
    const counts: Counts = { mediaReassigned: 0, albumsReassigned: 0, tagsReassigned: 0, peopleReassigned: 0 };
    const circleIds = new Set<string>();
    for (const rows of await Promise.all([
      this.prisma.mediaItem.groupBy({ by: ['circleId'], where: { addedById: userId } }),
      this.prisma.album.groupBy({ by: ['circleId'], where: { addedById: userId } }),
      this.prisma.tag.groupBy({ by: ['circleId'], where: { addedById: userId } }),
      this.prisma.person.groupBy({ by: ['circleId'], where: { addedById: userId } }),
    ])) {
      for (const row of rows) circleIds.add(row.circleId);
    }
    if (circleIds.size === 0) return counts;

    for (const circleId of circleIds) {
      const ownerId = await this.contentOwnerOf(circleId, userId);
      if (!ownerId) continue;
      const where = { addedById: userId, circleId };
      const data = { addedById: ownerId };
      counts.mediaReassigned += (await this.prisma.mediaItem.updateMany({ where, data })).count;
      counts.albumsReassigned += (await this.prisma.album.updateMany({ where, data })).count;
      counts.tagsReassigned += (await this.prisma.tag.updateMany({ where, data })).count;
      counts.peopleReassigned += (await this.prisma.person.updateMany({ where, data })).count;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // Factory reset
  // ---------------------------------------------------------------------------

  /**
   * The factory reset's storage sweep: every storage object outside the
   * surviving prefixes, bytes (per row) then row, paging forward by id.
   */
  async sweepStorageObjects(survivingPrefixes: readonly string[]): Promise<Counts> {
    const prefixes = [...new Set([...survivingPrefixes, ...MEMORIAHUB_SURVIVING_PREFIXES])];
    const notSurviving = { NOT: { OR: prefixes.map((prefix) => ({ storageKey: { startsWith: prefix } })) } };
    let cursor: string | undefined;
    let deleted = 0;
    let failed = 0;
    for (;;) {
      const page = await this.storageClient().storageObject.findMany({
        where: { ...notSurviving, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: STORED_OBJECT_SELECT,
        orderBy: { id: 'asc' },
        take: STORAGE_PURGE_PAGE,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      const result = await this.deleteStoredObjects(page);
      deleted += result.deleted;
      failed += result.failed;
    }
    return { storageObjectsDeleted: deleted, storageObjectsFailed: failed };
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
