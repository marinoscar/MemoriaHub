// =============================================================================
// Memories — read/act API service (epic #300, issue #307)
// =============================================================================
//
// Serves every user-facing Memories surface: the browsable history
// (`GET /api/memories`), the Home carousel (`/feed`), full detail, the per-user
// seen/hide/favorite state, the circle-level tombstone delete, and
// save-as-album.
//
// THREE INVARIANTS RUN THROUGH EVERY METHOD HERE:
//
//   1. THE TOMBSTONE (docs/specs/memories.md §2.5). `deletedAt IS NOT NULL` is
//      excluded from EVERY read without exception. Delete is circle-level and
//      permanent in effect: the natural-key unique index spans tombstoned rows,
//      so regeneration can never resurrect one. Per-user `hiddenAt` is a
//      DIFFERENT, personal thing and is deliberately not conflated with it — a
//      hidden memory is still there for everyone else, and still reachable by
//      its own id for the user who hid it.
//
//   2. THE ACTIVE FILTER. `expiresAt IS NULL OR expiresAt > now()`. Only
//      `on_this_day` sets an expiry (start of the day after its anchor), so
//      this is what stops yesterday's "6 years ago" card from lingering.
//
//   3. THE FEATURE FLAG IS CHECKED FIRST, BEFORE ANY QUERY. With
//      `features.memories` off — the default — the list and feed return an
//      empty page and the per-id routes 404, having issued exactly ZERO
//      database queries beyond the cached settings read. "Zero cost when off"
//      is a stated epic success criterion, not a nicety; putting the gate after
//      the circle-access check would already have cost two queries.
//
// Thumbnails on every payload are signed through
// `MediaThumbnailService.signThumbsBatched` — ONE `storageObject.findMany` per
// response, never a per-item lookup. A per-item N+1 here would re-introduce
// exactly the regression documented in docs/audits/search-audit.md.
// =============================================================================

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CircleRole, MemoryType, Prisma } from '@prisma/client';

import { CircleMembershipService } from '../../circles/circle-membership.service';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  MemoriesPreferencesValue,
  UserSettingsValue,
  isMemoriesEnabled,
} from '../../common/types/settings.types';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { MediaService } from '../../media/media.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  MemoryCardDto,
  MemoryDetailDto,
  MemoryDetailItemDto,
  MemoryFeedCardDto,
  MemoryFeedDto,
  MemoryListDto,
  SaveMemoryAlbumResultDto,
} from './dto/memory-response.dto';
import { MemoryFeedQueryDto, MemoryListQueryDto } from './dto/memory-query.dto';
import { SaveMemoryAlbumDto } from './dto/save-memory-album.dto';
import {
  ResolvedMemoryPreferences,
  isMemoryHiddenByPreferences,
  preferencesAreEmpty,
  resolveMemoryPreferences,
} from './memory-preferences';

/** Hard cap on feed cards, per the epic. */
const FEED_LIMIT = 10;

/**
 * How many non-`on_this_day` rows the feed reads before ranking. Larger than
 * FEED_LIMIT on purpose: per-user hidden rows are excluded in SQL, but the
 * preference filter runs in memory afterwards, so a user with several hidden
 * people would otherwise see a short feed. One bounded read, no second query.
 */
const FEED_CANDIDATE_LIMIT = 60;

/** Item thumbnails returned per feed card for the fan effect. */
const FEED_ITEM_THUMBS = 4;

/** Album names are capped at 256 by createAlbumSchema; a title may be longer. */
const ALBUM_NAME_MAX = 256;

/** Selection shared by the list and feed card projections. */
const CARD_SELECT = {
  id: true,
  type: true,
  title: true,
  subtitle: true,
  itemCount: true,
  periodStart: true,
  periodEnd: true,
  coverMediaItemId: true,
  meta: true,
  generatedAt: true,
  personId: true,
  coverMediaItem: { select: { id: true, metadata: true } },
} satisfies Prisma.MemorySelect;

type CardRow = Prisma.MemoryGetPayload<{ select: typeof CARD_SELECT }> & {
  userStates: Array<{
    seenAt: Date | null;
    hiddenAt: Date | null;
    favoritedAt: Date | null;
  }>;
};

type FeedRow = CardRow & {
  items: Array<{ mediaItem: { metadata: Prisma.JsonValue | null } }>;
};

@Injectable()
export class MemoriesService {
  private readonly logger = new Logger(MemoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly thumbnails: MediaThumbnailService,
    private readonly systemSettings: SystemSettingsService,
    private readonly mediaService: MediaService,
  ) {}

  // ===========================================================================
  // Gates
  // ===========================================================================

  /**
   * The single feature gate. Reads through `SystemSettingsService.getSettings()`
   * (5 s in-process cache) and folds in the `MEMORIES_ENABLED` env kill-switch
   * via the shared `isMemoriesEnabled()` helper, so this surface can never
   * disagree with the generation cron or the handler about what "enabled" means.
   */
  private async featureEnabled(): Promise<boolean> {
    const settings = await this.systemSettings.getSettings();
    return isMemoriesEnabled(settings as { features?: Record<string, boolean> });
  }

  /**
   * `WHERE` fragment shared by every read: circle scope, tombstone exclusion
   * and the active-expiry filter. Nothing in this service builds a memory query
   * without it.
   */
  private activeWhere(circleId: string): Prisma.MemoryWhereInput {
    return {
      circleId,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  /**
   * Load one memory by id and prove the caller may act on it at `required` rank.
   *
   * Deliberately NOT `assertCircleAccess`: a non-member must get **404, not
   * 403**, so a stranger cannot use the status code to confirm that a memory id
   * exists (the same enumeration-resistant policy as the notifications `:id`
   * routes and public shares). A member who simply lacks the RANK — a viewer
   * trying to delete — does get a 403, because their membership is not a secret
   * and the distinction is actionable to them.
   */
  private async loadAccessibleMemory(
    id: string,
    userId: string,
    permissions: string[],
    required: CircleRole,
  ) {
    const memory = await this.prisma.memory.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!memory) {
      throw new NotFoundException(`Memory ${id} not found`);
    }

    // Super-admins moderate any circle without being a member — the same bypass
    // CircleMembershipService.assertCircleAccess applies.
    const isSuperAdmin =
      permissions.includes(PERMISSIONS.CIRCLES_MANAGE_ANY) ||
      permissions.includes(PERMISSIONS.MEDIA_WRITE_ANY) ||
      permissions.includes(PERMISSIONS.MEDIA_READ_ANY);
    if (isSuperAdmin) return memory;

    const role = await this.circleMembership.resolveRole(userId, memory.circleId);
    if (role === null) {
      // Not a member: indistinguishable from "no such memory".
      throw new NotFoundException(`Memory ${id} not found`);
    }
    const rank: Record<CircleRole, number> = {
      viewer: 1,
      collaborator: 2,
      circle_admin: 3,
    };
    if (rank[role] < rank[required]) {
      throw new ForbiddenException(`This action requires ${required} role or higher`);
    }
    return memory;
  }

  /**
   * Read this user's `user_settings.memories` namespace and compile it.
   *
   * Absent namespace / absent row ⇒ no filtering, which is the normal state
   * (nothing is ever populated server-side). A read failure degrades to "no
   * preference" with a warning rather than failing the list — over-showing is
   * strictly better than a 500 on a browse surface.
   */
  private async loadPreferences(userId: string): Promise<ResolvedMemoryPreferences> {
    try {
      const row = await this.prisma.userSettings.findUnique({
        where: { userId },
        select: { value: true },
      });
      const value = row?.value as unknown as UserSettingsValue | undefined;
      return resolveMemoryPreferences(
        value?.memories as MemoriesPreferencesValue | undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to read memory preferences for user ${userId}: ${msg}`);
      return resolveMemoryPreferences(null);
    }
  }

  // ===========================================================================
  // GET /api/memories
  // ===========================================================================

  async list(
    query: MemoryListQueryDto,
    userId: string,
    permissions: string[],
  ): Promise<MemoryListDto> {
    const { circleId, type, year, favorite, cursor, pageSize } = query;

    // Gate FIRST — see invariant 3 in the file header.
    if (!(await this.featureEnabled())) {
      return { items: [], meta: { pageSize, nextCursor: null, hasMore: false } };
    }

    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      permissions,
      'viewer' as CircleRole,
    );

    const where: Prisma.MemoryWhereInput = {
      ...this.activeWhere(circleId),
      ...(type ? { type } : {}),
      ...(year ? this.yearOverlapWhere(year) : {}),
      // Per-user hide is excluded in SQL (unlike the preference filter, which
      // cannot be — see below), so a user who hid most of a circle's memories
      // still gets full pages.
      NOT: { userStates: { some: { userId, hiddenAt: { not: null } } } },
      ...(favorite === true
        ? { userStates: { some: { userId, favoritedAt: { not: null } } } }
        : {}),
    };

    const rawRows = await this.prisma.memory.findMany({
      where,
      select: {
        ...CARD_SELECT,
        userStates: {
          where: { userId },
          select: { seenAt: true, hiddenAt: true, favoritedAt: true },
        },
      },
      // `id` DESC is the tiebreak that makes the keyset deterministic when two
      // memories share a `generatedAt` — which they routinely do, since one
      // generation run writes a whole batch.
      orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const rows = rawRows as unknown as CardRow[];

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    // The cursor is derived from the RAW page, before preference filtering.
    // Deriving it from the filtered list would make a page whose every row was
    // preference-hidden return `nextCursor: null` and silently truncate the
    // history at the first fully-hidden page.
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;

    const prefs = await this.loadPreferences(userId);
    const visible = preferencesAreEmpty(prefs)
      ? page
      : page.filter((row) => !isMemoryHiddenByPreferences(row, prefs));

    const items = await this.toCards(visible);
    return { items, meta: { pageSize, nextCursor, hasMore } };
  }

  /**
   * `year` compiled to a range OVERLAP, because a memory covers a period rather
   * than sitting on a date: keep rows whose `[periodStart, periodEnd]` window
   * intersects that calendar year in UTC.
   */
  private yearOverlapWhere(year: number): Prisma.MemoryWhereInput {
    const start = new Date(Date.UTC(year, 0, 1));
    const endExclusive = new Date(Date.UTC(year + 1, 0, 1));
    return {
      periodStart: { lt: endExclusive },
      periodEnd: { gte: start },
    };
  }

  // ===========================================================================
  // GET /api/memories/feed
  // ===========================================================================

  /**
   * The Home carousel: today's `on_this_day` first (closest year first), then
   * the newest unseen, then the newest seen, capped at 10.
   *
   * Two bounded reads rather than one: today's anchor memories must appear even
   * when they are not among the newest rows overall (a backfill can generate a
   * pile of trips after them), and ranking them by `meta.yearsAgo` is a JSONB
   * sort SQL would do badly and an in-memory sort does trivially.
   */
  async feed(
    query: MemoryFeedQueryDto,
    userId: string,
    permissions: string[],
  ): Promise<MemoryFeedDto> {
    const { circleId } = query;

    if (!(await this.featureEnabled())) {
      return { items: [] };
    }

    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      permissions,
      'viewer' as CircleRole,
    );

    const notHidden: Prisma.MemoryWhereInput = {
      NOT: { userStates: { some: { userId, hiddenAt: { not: null } } } },
    };
    const feedSelect = {
      ...CARD_SELECT,
      userStates: {
        where: { userId },
        select: { seenAt: true, hiddenAt: true, favoritedAt: true },
      },
      items: {
        orderBy: { position: 'asc' as const },
        take: FEED_ITEM_THUMBS,
        select: { mediaItem: { select: { metadata: true } } },
      },
    };

    // `periodKey` for an `on_this_day` memory IS the anchor day in UTC
    // (`toIsoDateKey`), so "today's" is an exact string match rather than a
    // range scan — see on-this-day.curator.ts.
    const todayKey = new Date().toISOString().slice(0, 10);

    const [todayRaw, recentRaw] = await Promise.all([
      this.prisma.memory.findMany({
        where: {
          ...this.activeWhere(circleId),
          ...notHidden,
          type: MemoryType.on_this_day,
          periodKey: todayKey,
        },
        select: feedSelect,
        take: FEED_LIMIT,
      }),
      this.prisma.memory.findMany({
        where: {
          ...this.activeWhere(circleId),
          ...notHidden,
          NOT: [
            { AND: [{ type: MemoryType.on_this_day }, { periodKey: todayKey }] },
          ],
        },
        select: feedSelect,
        orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
        take: FEED_CANDIDATE_LIMIT,
      }),
    ]);
    const todayRows = todayRaw as unknown as FeedRow[];
    const recentRows = recentRaw as unknown as FeedRow[];

    const prefs = await this.loadPreferences(userId);
    const keep = (row: FeedRow) =>
      preferencesAreEmpty(prefs) || !isMemoryHiddenByPreferences(row, prefs);

    // Closest year first: "1 year ago" before "9 years ago".
    const today = todayRows
      .filter(keep)
      .sort((a, b) => this.yearsAgo(a) - this.yearsAgo(b));

    const rest = recentRows.filter(keep);
    const unseen = rest.filter((row) => !row.userStates[0]?.seenAt);
    const seen = rest.filter((row) => row.userStates[0]?.seenAt);

    const ordered = [...today, ...unseen, ...seen].slice(0, FEED_LIMIT);
    return { items: await this.toFeedCards(ordered) };
  }

  /** `meta.yearsAgo` written by the On This Day curator; unknown sorts last. */
  private yearsAgo(row: CardRow): number {
    const meta = row.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const value = (meta as Record<string, unknown>)['yearsAgo'];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  // ===========================================================================
  // GET /api/memories/:id
  // ===========================================================================

  /**
   * Full detail. Applies the tombstone and active filters (invariants 1 and 2)
   * but deliberately NOT the per-user preference filter and NOT the per-user
   * hide: a direct link — from the story player, a notification, an email
   * digest, or the user's own hidden list — must still resolve. Hiding and
   * deleting are the tools for making a memory go away, and both remain
   * available from this page.
   */
  async detail(
    id: string,
    userId: string,
    permissions: string[],
  ): Promise<MemoryDetailDto> {
    if (!(await this.featureEnabled())) {
      throw new NotFoundException(`Memory ${id} not found`);
    }

    await this.loadAccessibleMemory(id, userId, permissions, 'viewer' as CircleRole);

    const memory = await this.prisma.memory.findFirst({
      where: { id, deletedAt: null },
      include: {
        coverMediaItem: { select: { id: true, metadata: true } },
        userStates: {
          where: { userId },
          select: { seenAt: true, hiddenAt: true, favoritedAt: true },
        },
        items: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            mediaItemId: true,
            position: true,
            mediaItem: {
              select: {
                type: true,
                width: true,
                height: true,
                durationMs: true,
                capturedAt: true,
                metadata: true,
              },
            },
          },
        },
      },
    });
    if (!memory) {
      throw new NotFoundException(`Memory ${id} not found`);
    }

    // ONE batched signing call covering the cover AND every item.
    const coverKey = this.thumbnails.extractThumbKey(
      memory.coverMediaItem?.metadata ?? null,
    );
    const itemKeys = memory.items.map((item) =>
      this.thumbnails.extractThumbKey(item.mediaItem.metadata),
    );
    const signed = await this.thumbnails.signThumbsBatched(
      [coverKey, ...itemKeys].filter((k): k is string => k !== null),
    );

    const items: MemoryDetailItemDto[] = memory.items.map((item, i) => {
      const key = itemKeys[i];
      return {
        id: item.id,
        mediaItemId: item.mediaItemId,
        position: item.position,
        mediaType: item.mediaItem.type,
        width: item.mediaItem.width,
        height: item.mediaItem.height,
        durationMs: item.mediaItem.durationMs,
        capturedAt: item.mediaItem.capturedAt?.toISOString() ?? null,
        thumbnailUrl: key ? signed.get(key) ?? null : null,
      };
    });

    const state = memory.userStates[0];
    return {
      id: memory.id,
      circleId: memory.circleId,
      type: memory.type,
      title: memory.title,
      subtitle: memory.subtitle,
      narrative: memory.narrative,
      titleSource: memory.titleSource,
      titleModel: memory.titleModel,
      personId: memory.personId,
      itemCount: memory.itemCount,
      periodStart: memory.periodStart.toISOString(),
      periodEnd: memory.periodEnd.toISOString(),
      coverMediaItemId: memory.coverMediaItemId,
      coverThumbnailUrl: coverKey ? signed.get(coverKey) ?? null : null,
      meta: memory.meta,
      myState: {
        seen: Boolean(state?.seenAt),
        hidden: Boolean(state?.hiddenAt),
        favorited: Boolean(state?.favoritedAt),
      },
      generatedAt: memory.generatedAt.toISOString(),
      refreshedAt: memory.refreshedAt.toISOString(),
      expiresAt: memory.expiresAt?.toISOString() ?? null,
      items,
    };
  }

  // ===========================================================================
  // Per-user state
  // ===========================================================================

  /** `seenAt = COALESCE(seenAt, now())` — idempotent, first view wins. */
  async markSeen(id: string, userId: string, permissions: string[]): Promise<void> {
    await this.requireMemberMemory(id, userId, permissions);
    await this.setUserStateTimestamp(id, userId, 'seenAt');
  }

  async hide(id: string, userId: string, permissions: string[]): Promise<void> {
    await this.requireMemberMemory(id, userId, permissions);
    await this.setUserStateTimestamp(id, userId, 'hiddenAt');
  }

  async unhide(id: string, userId: string, permissions: string[]): Promise<void> {
    await this.requireMemberMemory(id, userId, permissions);
    await this.clearUserStateTimestamp(id, userId, 'hiddenAt');
  }

  async favorite(id: string, userId: string, permissions: string[]): Promise<void> {
    await this.requireMemberMemory(id, userId, permissions);
    await this.setUserStateTimestamp(id, userId, 'favoritedAt');
  }

  async unfavorite(id: string, userId: string, permissions: string[]): Promise<void> {
    await this.requireMemberMemory(id, userId, permissions);
    await this.clearUserStateTimestamp(id, userId, 'favoritedAt');
  }

  /** State writes need membership only — viewer rank, no elevated permission. */
  private async requireMemberMemory(
    id: string,
    userId: string,
    permissions: string[],
  ) {
    if (!(await this.featureEnabled())) {
      throw new NotFoundException(`Memory ${id} not found`);
    }
    return this.loadAccessibleMemory(id, userId, permissions, 'viewer' as CircleRole);
  }

  /**
   * Set one `MemoryUserState` timestamp with COALESCE semantics.
   *
   * Two statements rather than one because that is what COALESCE-on-upsert
   * costs in Prisma: the `upsert` covers "no row yet", and the guarded
   * `updateMany` covers "a row exists because the user favorited it earlier but
   * this particular column is still null". Re-running never moves an existing
   * timestamp, so `seenAt` keeps naming the FIRST view — the same idempotency
   * contract as `POST /api/notifications/:id/read`.
   */
  private async setUserStateTimestamp(
    memoryId: string,
    userId: string,
    field: 'seenAt' | 'hiddenAt' | 'favoritedAt',
  ): Promise<void> {
    const now = new Date();
    await this.prisma.memoryUserState.upsert({
      where: { memoryId_userId: { memoryId, userId } },
      create: { memoryId, userId, [field]: now },
      update: {},
    });
    await this.prisma.memoryUserState.updateMany({
      where: { memoryId, userId, [field]: null },
      data: { [field]: now },
    });
  }

  /**
   * Clear one timestamp. `updateMany`, never an upsert: un-hiding a memory the
   * user never hid is a no-op, and creating an all-null state row to record
   * that nothing happened would be pure garbage.
   */
  private async clearUserStateTimestamp(
    memoryId: string,
    userId: string,
    field: 'hiddenAt' | 'favoritedAt',
  ): Promise<void> {
    await this.prisma.memoryUserState.updateMany({
      where: { memoryId, userId },
      data: { [field]: null },
    });
  }

  // ===========================================================================
  // DELETE /api/memories/:id — the tombstone
  // ===========================================================================

  /**
   * Circle-level delete. Sets `deletedAt`, which removes the memory for EVERY
   * member and — because the `(circleId, type, periodKey, subjectKey)` unique
   * index spans tombstoned rows — permanently: `upsertMemory` sees the row,
   * recognises the tombstone and skips it, so no future generation run can
   * recreate it (docs/specs/memories.md §2.5).
   *
   * Requires `media:write` + collaborator, the same bar as any other mutation
   * of circle content. A viewer who merely wants it out of their own way has
   * `POST /:id/hide`.
   */
  async remove(id: string, userId: string, permissions: string[]): Promise<void> {
    if (!(await this.featureEnabled())) {
      throw new NotFoundException(`Memory ${id} not found`);
    }
    const memory = await this.loadAccessibleMemory(
      id,
      userId,
      permissions,
      'collaborator' as CircleRole,
    );

    await this.prisma.memory.update({
      where: { id: memory.id },
      data: { deletedAt: new Date() },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'memory:deleted',
        targetType: 'memory',
        targetId: memory.id,
        meta: {
          circleId: memory.circleId,
          type: memory.type,
          periodKey: memory.periodKey,
          subjectKey: memory.subjectKey,
          title: memory.title,
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Memory ${memory.id} (${memory.type}) tombstoned in circle ${memory.circleId} by user ${userId}`,
    );
  }

  // ===========================================================================
  // POST /api/memories/:id/save-album
  // ===========================================================================

  /**
   * Materialise a memory as a real album.
   *
   * Every mutation goes through the EXISTING album service path
   * (`MediaService.createAlbum` / `addAlbumItems` / `updateAlbum`) rather than
   * writing `Album`/`AlbumItem` rows directly, so this inherits their circle
   * checks, their `MediaTouchService` backup-feed bookkeeping and their cover
   * validation for free, and cannot drift from them.
   *
   * NOT idempotent by design (per issue #307): saving the same memory twice
   * yields two albums, because a user may genuinely want a second copy to edit.
   *
   * Item order is the memory's `position` order. Soft-deleted items are dropped
   * first: `addAlbumItems` rejects the whole batch if any id is trashed, and a
   * memory generated before a photo was trashed would otherwise be unsaveable.
   */
  async saveAsAlbum(
    id: string,
    dto: SaveMemoryAlbumDto,
    userId: string,
    permissions: string[],
  ): Promise<SaveMemoryAlbumResultDto> {
    if (!(await this.featureEnabled())) {
      throw new NotFoundException(`Memory ${id} not found`);
    }
    const memory = await this.loadAccessibleMemory(
      id,
      userId,
      permissions,
      'collaborator' as CircleRole,
    );

    const memoryItems = await this.prisma.memoryItem.findMany({
      where: { memoryId: memory.id },
      orderBy: { position: 'asc' },
      select: { mediaItemId: true },
    });

    const live = await this.prisma.mediaItem.findMany({
      where: {
        id: { in: memoryItems.map((item) => item.mediaItemId) },
        circleId: memory.circleId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const liveIds = new Set(live.map((row) => row.id));
    const orderedIds = memoryItems
      .map((item) => item.mediaItemId)
      .filter((mediaItemId) => liveIds.has(mediaItemId));

    const name = (dto?.name ?? memory.title).slice(0, ALBUM_NAME_MAX).trim();
    if (!name) {
      throw new BadRequestException('Album name cannot be empty');
    }

    const album = await this.mediaService.createAlbum(
      { circleId: memory.circleId, name },
      userId,
      permissions,
    );

    if (orderedIds.length > 0) {
      // Sequential inserts inside addAlbumItems preserve `addedAt` order, which
      // is the order `GET /api/media/albums/:id` reads items back in.
      await this.mediaService.addAlbumItems(
        album.id,
        { mediaItemIds: orderedIds },
        userId,
        permissions,
      );
    }

    // The cover only survives if it is actually a member — updateAlbum enforces
    // that, and a memory whose cover photo was trashed must not 400 the save.
    if (memory.coverMediaItemId && liveIds.has(memory.coverMediaItemId)) {
      await this.mediaService.updateAlbum(
        album.id,
        { coverMediaItemId: memory.coverMediaItemId },
        userId,
        permissions,
      );
    }

    this.logger.log(
      `Memory ${memory.id} saved as album ${album.id} (${orderedIds.length} item(s)) by user ${userId}`,
    );

    return { albumId: album.id };
  }

  // ===========================================================================
  // Projections
  // ===========================================================================

  /** Card projection with ONE batched signing call for the whole page. */
  private async toCards(rows: CardRow[]): Promise<MemoryCardDto[]> {
    const coverKeys = rows.map((row) =>
      this.thumbnails.extractThumbKey(row.coverMediaItem?.metadata ?? null),
    );
    const signed = await this.thumbnails.signThumbsBatched(
      coverKeys.filter((k): k is string => k !== null),
    );
    return rows.map((row, i) => this.toCard(row, coverKeys[i], signed));
  }

  /**
   * Feed projection. Signs cover AND item thumbnails for every card in ONE
   * batched call — the fan effect needs 4 extra thumbnails per card, which is
   * exactly the shape that becomes an N+1 if signed per item.
   */
  private async toFeedCards(rows: FeedRow[]): Promise<MemoryFeedCardDto[]> {
    const coverKeys = rows.map((row) =>
      this.thumbnails.extractThumbKey(row.coverMediaItem?.metadata ?? null),
    );
    const itemKeys = rows.map((row) =>
      row.items.map((item) =>
        this.thumbnails.extractThumbKey(item.mediaItem.metadata),
      ),
    );
    const signed = await this.thumbnails.signThumbsBatched(
      [...coverKeys, ...itemKeys.flat()].filter((k): k is string => k !== null),
    );

    return rows.map((row, i) => ({
      ...this.toCard(row, coverKeys[i], signed),
      itemThumbnailUrls: itemKeys[i]
        .map((key) => (key ? signed.get(key) ?? null : null))
        .filter((url): url is string => url !== null),
    }));
  }

  private toCard(
    row: CardRow,
    coverKey: string | null,
    signed: Map<string, string | null>,
  ): MemoryCardDto {
    const state = row.userStates[0];
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      itemCount: row.itemCount,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      coverMediaItemId: row.coverMediaItemId,
      coverThumbnailUrl: coverKey ? signed.get(coverKey) ?? null : null,
      meta: row.meta,
      myState: {
        seen: Boolean(state?.seenAt),
        favorited: Boolean(state?.favoritedAt),
      },
      generatedAt: row.generatedAt.toISOString(),
    };
  }
}
