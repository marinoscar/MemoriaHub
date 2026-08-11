import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LocationGroupLevel, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { LocationGroupResolverService } from './location-group-resolver.service';
import { LocationGroupRebuildService } from './location-group-rebuild.service';
import { fold, stripNoise, suggestionKey } from './normalize-location-name';
import type {
  CreateLocationGroupDto,
  ListLocationGroupSuggestionsDto,
  ListLocationGroupsDto,
  ListLocationValuesDto,
  MergeLocationGroupsDto,
  UpdateLocationGroupDto,
} from './dto/location-group.dto';

/**
 * Per-level column mapping, identical to the rebuild handler's — `raw` is the
 * geocoder-owned column, `canonical` the derived one this feature maintains.
 */
export const LEVEL_COLUMNS: Record<
  LocationGroupLevel,
  {
    raw: 'geoCountry' | 'geoAdmin1' | 'geoLocality';
    canonical: 'geoCanonicalCountry' | 'geoCanonicalAdmin1' | 'geoCanonicalLocality';
  }
> = {
  country: { raw: 'geoCountry', canonical: 'geoCanonicalCountry' },
  region: { raw: 'geoAdmin1', canonical: 'geoCanonicalAdmin1' },
  locality: { raw: 'geoLocality', canonical: 'geoCanonicalLocality' },
};

/** Minimum distinct values a suggestion cluster must contain to be proposed. */
const MIN_SUGGESTION_CLUSTER_SIZE = 2;

/**
 * Page size `GET /api/location-groups/values` falls back to when a caller opts
 * into paginated mode with `page` alone. See `listValues`' precedence note.
 */
const DEFAULT_VALUES_PAGE_SIZE = 50;

/**
 * Title-case a folded, noise-stripped name for a proposed canonical name.
 * "heredia" → "Heredia", "san jose" → "San Jose".
 */
export function titleCase(s: string): string {
  return s
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface GroupItemCountKey {
  level: LocationGroupLevel;
  canonicalName: string;
  countryCode: string;
}

/**
 * LocationGroupsService — the management API behind `/api/location-groups/*`
 * and `POST /api/admin/location-groups/rebuild` (issue #374).
 *
 * ─── Two rules every mutation here obeys ───────────────────────────────────
 *
 * 1. `resolver.invalidate()` — without it an admin edit takes up to the
 *    resolver's 30s TTL to affect the canonical name written to the NEXT
 *    upload, so a freshly-created group would silently not apply for half a
 *    minute.
 *
 * 2. `rebuild.enqueueRebuild()` — the resolver only governs FUTURE writes; the
 *    already-materialised `media_items.geo_canonical_*` columns are re-derived
 *    by the rebuild job. `LocationGroupRebuildService` deliberately does NOT
 *    pass `skipDedup`, so a burst of admin edits collapses into ONE rebuild.
 *
 *    ⚠️ Mutations enqueue a FULL rebuild (`{}`), never `{ groupIds: [id] }`.
 *    The rebuild's RESET pass always runs over the entire scope and only the
 *    listed groups are re-applied afterwards, so a group-scoped rebuild would
 *    strand every OTHER group's canonical names at their raw values. The
 *    `groupIds` option exists only on the explicit admin rebuild endpoint,
 *    where the caller owns that tradeoff.
 *
 * ─── Counting ─────────────────────────────────────────────────────────────
 *
 * Item counts are ALWAYS derived from a `groupBy` over a canonical column —
 * one per level involved, never one query per group or per alias. A page of 50
 * groups therefore costs at most three aggregate queries, not 50.
 */
@Injectable()
export class LocationGroupsService {
  private readonly logger = new Logger(LocationGroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly resolver: LocationGroupResolverService,
    private readonly rebuild: LocationGroupRebuildService,
    private readonly thumbnails: MediaThumbnailService,
  ) {}

  // ===========================================================================
  // Read
  // ===========================================================================

  /**
   * `GET /api/location-groups` — paginated group list with live item counts.
   */
  async list(query: ListLocationGroupsDto) {
    const { level, enabled, q, page, pageSize } = query;

    const where: Prisma.LocationGroupWhereInput = {
      ...(level ? { level: level as LocationGroupLevel } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(q ? { canonicalName: { contains: q, mode: 'insensitive' as const } } : {}),
    };

    const [total, groups] = await Promise.all([
      this.prisma.locationGroup.count({ where }),
      this.prisma.locationGroup.findMany({
        where,
        orderBy: [{ level: 'asc' }, { canonicalName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { aliases: true } },
          coverMediaItem: { select: { id: true, metadata: true } },
        },
      }),
    ]);

    const counts = await this.countItemsForGroups(groups);
    const coverUrls = await this.signCovers(groups.map((g) => g.coverMediaItem?.metadata ?? null));

    return {
      items: groups.map((group, index) => ({
        id: group.id,
        level: group.level,
        canonicalName: group.canonicalName,
        countryCode: group.countryCode,
        memberCount: group._count.aliases,
        itemCount: counts.get(this.countKey(group)) ?? 0,
        coverMediaItemId: group.coverMediaItemId,
        coverThumbnailUrl: coverUrls[index] ?? null,
        centerLat: group.centerLat,
        centerLng: group.centerLng,
        radiusKm: group.radiusKm,
        enabled: group.enabled,
        notes: group.notes,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      })),
      meta: { total, page, pageSize },
    };
  }

  /**
   * `GET /api/location-groups/:id` — group detail plus every alias with its
   * own item count.
   *
   * Alias counts come from ONE `groupBy` over the level's RAW column (aliases
   * are raw spellings), folded in memory — never a count query per alias.
   */
  async get(id: string) {
    const group = await this.prisma.locationGroup.findUnique({
      where: { id },
      include: {
        aliases: { orderBy: { rawValue: 'asc' } },
        _count: { select: { aliases: true } },
        coverMediaItem: { select: { id: true, metadata: true } },
      },
    });
    if (!group) throw new NotFoundException(`Location group ${id} not found`);

    const cols = LEVEL_COLUMNS[group.level];

    const rawRows = await this.prisma.mediaItem.groupBy({
      by: [cols.raw, 'geoCountryCode'],
      where: {
        deletedAt: null,
        [cols.raw]: { not: null },
        ...(group.countryCode ? { geoCountryCode: group.countryCode } : {}),
      },
      _count: { _all: true },
    });

    // Fold on the NORMALIZED raw value so "SAN JOSE" counts toward the alias
    // that stores "San José" — the same equivalence the resolver applies.
    const byNormalized = new Map<string, number>();
    for (const row of rawRows as unknown as Array<Record<string, unknown>>) {
      const value = row[cols.raw] as string | null;
      if (!value) continue;
      const count = (row['_count'] as { _all: number })._all;
      const key = fold(value);
      byNormalized.set(key, (byNormalized.get(key) ?? 0) + count);
    }

    const counts = await this.countItemsForGroups([group]);
    const [coverThumbnailUrl] = await this.signCovers([group.coverMediaItem?.metadata ?? null]);

    return {
      id: group.id,
      level: group.level,
      canonicalName: group.canonicalName,
      normalizedName: group.normalizedName,
      countryCode: group.countryCode,
      memberCount: group._count.aliases,
      itemCount: counts.get(this.countKey(group)) ?? 0,
      coverMediaItemId: group.coverMediaItemId,
      coverThumbnailUrl: coverThumbnailUrl ?? null,
      centerLat: group.centerLat,
      centerLng: group.centerLng,
      radiusKm: group.radiusKm,
      enabled: group.enabled,
      notes: group.notes,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      aliases: group.aliases.map((alias) => ({
        id: alias.id,
        rawValue: alias.rawValue,
        normalizedValue: alias.normalizedValue,
        countryCode: alias.countryCode,
        itemCount: byNormalized.get(alias.normalizedValue) ?? 0,
        createdAt: alias.createdAt,
      })),
    };
  }

  /**
   * `GET /api/location-groups/values` — every distinct RAW value present in the
   * library at a tier, app-wide (groups are global, so this is deliberately not
   * circle-scoped), annotated with the group that already owns it.
   *
   * ONE `groupBy` over the raw column + `geoCountryCode`, plus ONE alias read.
   *
   * ─── `limit` vs `page`/`pageSize` precedence (issue #407) ─────────────────
   *
   * The endpoint has TWO modes, selected by whether `page` or `pageSize` is
   * present in the query:
   *
   *   - **Paginated mode** (`page` and/or `pageSize` supplied) — `page`
   *     defaults to 1, `pageSize` to {@link DEFAULT_VALUES_PAGE_SIZE}, and
   *     `limit` is IGNORED entirely. This is the mode the select-many-and-merge
   *     checkbox list uses: a cap it cannot page past would make "showing 50 of
   *     812" a lie it can never resolve.
   *
   *   - **Legacy mode** (neither supplied) — behaves exactly as before: the
   *     first `limit` values (default 500). `LocationGroupEditorDialog`'s member
   *     picker passes `limit: 50` and is unaffected.
   *
   * `meta.total` is the count BEFORE slicing in BOTH modes — it was previously
   * the post-slice length, which made an honest "showing N of M" impossible.
   * `meta.page`/`meta.pageSize` are always present (legacy mode reports page 1
   * with `pageSize === limit`), and `meta.limit` is echoed so a legacy client
   * reading it keeps working.
   */
  async listValues(query: ListLocationValuesDto) {
    const level = query.level as LocationGroupLevel;
    const cols = LEVEL_COLUMNS[level];

    const rows = await this.prisma.mediaItem.groupBy({
      by: [cols.raw, 'geoCountryCode'],
      where: {
        deletedAt: null,
        [cols.raw]: {
          not: null,
          ...(query.q ? { contains: query.q, mode: 'insensitive' as const } : {}),
        },
      },
      _count: { _all: true },
    });

    const owners = await this.loadOwnershipIndex(level);

    const values = (rows as unknown as Array<Record<string, unknown>>)
      .map((row) => {
        const value = row[cols.raw] as string | null;
        if (!value) return null;
        const countryCode = (row['geoCountryCode'] as string | null) ?? '';
        const owner = this.lookupOwner(owners, countryCode, fold(value));
        return {
          value,
          countryCode: (row['geoCountryCode'] as string | null) ?? null,
          itemCount: (row['_count'] as { _all: number })._all,
          groupId: owner?.groupId ?? null,
          groupCanonicalName: owner?.canonicalName ?? null,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .filter((v) => {
        if (query.grouped === 'ungrouped') return v.groupId === null;
        if (query.grouped === 'grouped') return v.groupId !== null;
        return true;
      })
      .sort((a, b) => b.itemCount - a.itemCount || a.value.localeCompare(b.value));

    // Count BEFORE slicing — this is the number a "showing N of M" label needs.
    const total = values.length;

    const paginated = query.page !== undefined || query.pageSize !== undefined;
    const page = paginated ? (query.page ?? 1) : 1;
    const pageSize = paginated ? (query.pageSize ?? DEFAULT_VALUES_PAGE_SIZE) : query.limit;

    const offset = (page - 1) * pageSize;
    const items = values.slice(offset, offset + pageSize);

    return { items, meta: { total, page, pageSize, limit: query.limit } };
  }

  /**
   * `GET /api/location-groups/suggestions` — clusters of two or more UNGROUPED
   * raw values that share a `suggestionKey`.
   *
   * `suggestionKey` (fold + level-aware administrative-noise stripping) is used
   * ONLY here. It is deliberately lossy enough that two genuinely distinct
   * administrative units can share a key — acceptable when PROPOSING a group to
   * an admin, unacceptable in resolution, which is why the resolver uses the
   * conservative `fold` instead.
   */
  async suggestions(query: ListLocationGroupSuggestionsDto) {
    const level = query.level as LocationGroupLevel;
    const cols = LEVEL_COLUMNS[level];

    const settings = await this.systemSettings.getSettings();
    const minItems = settings.locationGrouping?.suggestionMinItems ?? 1;

    const rows = await this.prisma.mediaItem.groupBy({
      by: [cols.raw, 'geoCountryCode'],
      where: { deletedAt: null, [cols.raw]: { not: null } },
      _count: { _all: true },
    });

    const owners = await this.loadOwnershipIndex(level);

    // Bucket by (countryCode, suggestionKey). Country scope is part of the key
    // so an "Ontario" in CA and an "Ontario" in US are never proposed as one
    // group — the same scoping rule the alias unique index enforces.
    const buckets = new Map<
      string,
      { countryCode: string; members: Map<string, number> }
    >();

    for (const row of rows as unknown as Array<Record<string, unknown>>) {
      const value = row[cols.raw] as string | null;
      if (!value) continue;
      const itemCount = (row['_count'] as { _all: number })._all;
      if (itemCount < minItems) continue;

      const countryCode = (row['geoCountryCode'] as string | null) ?? '';
      // Already claimed by a group ⇒ nothing to suggest.
      if (this.lookupOwner(owners, countryCode, fold(value))) continue;

      const key = `${countryCode}|${suggestionKey(level, value)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { countryCode, members: new Map<string, number>() };
        buckets.set(key, bucket);
      }
      // The same raw spelling can appear under one countryCode more than once
      // only across different rows; sum rather than overwrite.
      bucket.members.set(value, (bucket.members.get(value) ?? 0) + itemCount);
    }

    const clusters = Array.from(buckets.values())
      .filter((bucket) => bucket.members.size >= MIN_SUGGESTION_CLUSTER_SIZE)
      .map((bucket) => {
        const members = Array.from(bucket.members.entries())
          .map(([value, itemCount]) => ({ value, itemCount }))
          .sort((a, b) => b.itemCount - a.itemCount || a.value.localeCompare(b.value));

        // The shortest member AFTER noise-stripping, title-cased: "Heredia",
        // "Heredia Province" and "Provincia de Heredia" all strip to "heredia",
        // so the cluster proposes "Heredia".
        const stripped = members
          .map((m) => stripNoise(level, fold(m.value)))
          .filter((s) => s.length > 0)
          .sort((a, b) => a.length - b.length || a.localeCompare(b));

        return {
          suggestedCanonicalName: titleCase(stripped[0] ?? members[0].value),
          countryCode: bucket.countryCode || null,
          members,
          totalItems: members.reduce((sum, m) => sum + m.itemCount, 0),
        };
      })
      .sort((a, b) => b.totalItems - a.totalItems)
      .slice(0, query.limit);

    return { items: clusters, meta: { total: clusters.length, limit: query.limit } };
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  /** `POST /api/location-groups`. */
  async create(dto: CreateLocationGroupDto, userId: string | null) {
    const level = dto.level as LocationGroupLevel;
    const countryCode = dto.countryCode ?? '';
    const canonicalName = dto.canonicalName.trim();

    const geo = await this.validateGeometry(dto.center ?? null, dto.radiusKm ?? null);

    const group = await this.createGroupWithMembers(
      {
        level,
        countryCode,
        canonicalName,
        memberValues: dto.memberValues ?? [],
        enabled: dto.enabled ?? true,
        notes: dto.notes ?? null,
        geo,
        createdById: userId,
      },
      this.prisma,
    );

    // The cover check runs AFTER creation because it is evaluated against the
    // group's member set (see assertCoverBelongs), which does not exist until
    // the aliases do. A rejected cover therefore leaves the group created and
    // coverless rather than silently accepting a wrong photo.
    if (dto.coverMediaItemId) {
      await this.assertCoverBelongs(group.id, dto.coverMediaItemId);
      await this.prisma.locationGroup.update({
        where: { id: group.id },
        data: { coverMediaItemId: dto.coverMediaItemId },
      });
    }

    await this.afterMutation('create', group.id);
    return this.get(group.id);
  }

  /** `PATCH /api/location-groups/:id`. */
  async update(id: string, dto: UpdateLocationGroupDto) {
    const group = await this.prisma.locationGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException(`Location group ${id} not found`);

    const data: Prisma.LocationGroupUpdateInput = {};

    if (dto.canonicalName !== undefined) {
      const canonicalName = dto.canonicalName.trim();
      const normalizedName = fold(canonicalName);
      if (normalizedName !== group.normalizedName) {
        const clash = await this.prisma.locationGroup.findUnique({
          where: {
            level_countryCode_normalizedName: {
              level: group.level,
              countryCode: group.countryCode,
              normalizedName,
            },
          },
          select: { id: true, canonicalName: true },
        });
        if (clash && clash.id !== id) {
          throw this.conflict(
            `A ${group.level} group named "${clash.canonicalName}" already exists in this scope`,
            clash.id,
            clash.canonicalName,
          );
        }
        await this.assertMembersUnclaimed(
          group.level,
          group.countryCode,
          [canonicalName],
          id,
        );
      }
      data.canonicalName = canonicalName;
      data.normalizedName = normalizedName;
    }

    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.notes !== undefined) data.notes = dto.notes;

    // center/radius are validated as a PAIR against the values that will be in
    // effect after the patch, so clearing one without the other is a 400 rather
    // than a half-configured area that silently never matches.
    if (dto.center !== undefined || dto.radiusKm !== undefined) {
      const nextCenter =
        dto.center !== undefined
          ? dto.center
          : group.centerLat !== null && group.centerLng !== null
            ? { lat: group.centerLat, lng: group.centerLng }
            : null;
      const nextRadius = dto.radiusKm !== undefined ? dto.radiusKm : group.radiusKm;
      const geo = await this.validateGeometry(nextCenter, nextRadius);
      data.centerLat = geo.centerLat;
      data.centerLng = geo.centerLng;
      data.radiusKm = geo.radiusKm;
    }

    if (dto.coverMediaItemId !== undefined) {
      if (dto.coverMediaItemId === null) {
        data.coverMediaItem = { disconnect: true };
      } else {
        await this.assertCoverBelongs(id, dto.coverMediaItemId);
        data.coverMediaItem = { connect: { id: dto.coverMediaItemId } };
      }
    }

    await this.prisma.locationGroup.update({ where: { id }, data });
    await this.afterMutation('update', id);
    return this.get(id);
  }

  /** `DELETE /api/location-groups/:id` — aliases cascade via the FK. */
  async remove(id: string): Promise<void> {
    const group = await this.prisma.locationGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!group) throw new NotFoundException(`Location group ${id} not found`);

    await this.prisma.locationGroup.delete({ where: { id } });
    await this.afterMutation('delete', id);
  }

  /** `POST /api/location-groups/:id/members`. */
  async addMembers(id: string, values: string[]): Promise<{ added: number }> {
    const group = await this.prisma.locationGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException(`Location group ${id} not found`);

    const added = await this.attachMembers(group, this.dedupeValues(values), this.prisma);

    await this.afterMutation('addMembers', id);
    return { added };
  }

  /**
   * `POST /api/location-groups/merge` (issue #407) — fold a multi-select of raw
   * values into ONE group in a single call.
   *
   * Two shapes, and EXACTLY ONE of them (both-or-neither is a 400):
   *
   *   - `canonicalName` — create a new group owning `values`. If a group with
   *     that name already exists in scope this is a `409` carrying the existing
   *     group at `details.groupId`, NOT a silent merge into it: the caller asked
   *     to create, and re-targeting their request is exactly the kind of guess
   *     the "block, never re-parent" rule exists to forbid. The client can
   *     re-send with `targetGroupId` set to that id.
   *
   *   - `targetGroupId` — add `values` to an existing group. The group is NEVER
   *     renamed; merging values into "The Woodlands" must not turn it into
   *     "Conroe" because that happened to be the first value selected.
   *
   * Everything is written inside ONE transaction, so a conflict discovered on
   * the fourth value cannot leave the first three already claimed. Exactly ONE
   * rebuild is enqueued afterwards — never inside the transaction, since a
   * rolled-back merge must not leave a rebuild job behind.
   *
   * Values the TARGET already owns are a no-op (`skippedMemberCount`), not a
   * conflict, so re-merging the same selection is idempotent. Values owned by a
   * DIFFERENT group are the standard `409` with `details.groupId` /
   * `details.groupName`.
   */
  async merge(dto: MergeLocationGroupsDto, userId: string | null) {
    const level = dto.level as LocationGroupLevel;

    const targetGroupId = dto.targetGroupId?.trim() || null;
    const canonicalName = dto.canonicalName?.trim() || null;

    // XOR, checked here rather than as a zod `.refine` so the rule has exactly
    // ONE place it can fail — the same reasoning behind center/radiusKm.
    if ((targetGroupId === null) === (canonicalName === null)) {
      throw new BadRequestException(
        'Supply exactly one of targetGroupId (merge into an existing group) or canonicalName (create a new one)',
      );
    }

    const values = this.dedupeValues(dto.values);
    if (values.length === 0) {
      throw new BadRequestException('values must contain at least one non-blank value');
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      if (targetGroupId !== null) {
        const group = await tx.locationGroup.findUnique({ where: { id: targetGroupId } });
        if (!group) throw new NotFoundException(`Location group ${targetGroupId} not found`);

        // A tier mismatch means the caller is merging city names into a region
        // group (or vice versa) — never a typo worth guessing through, since
        // the alias rows would then be unreachable by the resolver at either
        // tier.
        if (group.level !== level) {
          throw new BadRequestException(
            `Location group ${targetGroupId} is a ${group.level} group; the request declared level "${level}"`,
          );
        }
        // An omitted countryCode — or the '' UNSCOPED sentinel — inherits the
        // target's scope. That leniency is REQUIRED, not laziness: the region
        // and city tiers of `GET /api/media/explore/locations/:level` aggregate
        // ACROSS countries and carry no code, so a caller merging from those
        // surfaces genuinely cannot know the target's country (the same erasure
        // behind the cover-override bug this issue also fixes).
        //
        // A NON-EMPTY countryCode that disagrees is still rejected rather than
        // quietly ignored, because the alias rows are always written with the
        // GROUP's scope and the caller would otherwise believe they had claimed
        // values in a different one.
        if (dto.countryCode && dto.countryCode !== group.countryCode) {
          throw new BadRequestException(
            `Location group ${targetGroupId} is scoped to countryCode "${group.countryCode}"; the request declared "${dto.countryCode}"`,
          );
        }

        const added = await this.attachMembers(group, values, tx);
        return { groupId: group.id, created: false, added };
      }

      const group = await this.createGroupWithMembers(
        {
          level,
          countryCode: dto.countryCode ?? '',
          canonicalName: canonicalName as string,
          memberValues: values,
          enabled: true,
          notes: null,
          geo: { centerLat: null, centerLng: null, radiusKm: null },
          createdById: userId,
        },
        tx,
      );
      // Every submitted value is claimed by construction here — a value another
      // group owned would have thrown, and the group is brand new so nothing
      // could already have been there.
      return { groupId: group.id, created: true, added: values.length };
    });

    const job = await this.afterMutation('merge', outcome.groupId);

    return {
      groupId: outcome.groupId,
      created: outcome.created,
      // `added` rather than a merge-specific name, so it reads the same as
      // `POST /:id/members`' `{ added }`.
      added: outcome.added,
      // Values the target already owned, folded away by createMany's
      // skipDuplicates. Reported rather than hidden so a client can say
      // "3 added, 2 already there" instead of implying it moved five.
      skipped: Math.max(values.length - outcome.added, 0),
      // The rebuild this merge enqueued, so the admin page can poll it exactly
      // as it polls an explicit `POST /api/admin/location-groups/rebuild`.
      // Note it may be a job an EARLIER mutation enqueued: the rebuild service
      // deliberately does not pass `skipDedup`, so a burst of merges collapses
      // into one pending job — which is the desired behaviour, not a defect.
      jobId: job.id,
      status: job.status,
      group: await this.get(outcome.groupId),
    };
  }

  /** `DELETE /api/location-groups/:id/members`. */
  async removeMembers(id: string, values: string[]): Promise<{ removed: number }> {
    const group = await this.prisma.locationGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException(`Location group ${id} not found`);

    const normalized = this.dedupeValues(values).map((v) => fold(v));

    const result = await this.prisma.locationGroupAlias.deleteMany({
      where: { groupId: id, normalizedValue: { in: normalized } },
    });

    await this.afterMutation('removeMembers', id);
    return { removed: result.count };
  }

  /** `POST /api/admin/location-groups/rebuild`. */
  async triggerRebuild(payload: { circleId?: string; groupIds?: string[] }) {
    this.resolver.invalidate();
    const job = await this.rebuild.enqueueRebuild({
      ...(payload.circleId ? { circleId: payload.circleId } : {}),
      ...(payload.groupIds ? { groupIds: payload.groupIds } : {}),
    });
    return { data: { jobId: job.id, status: job.status } };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Create a group plus its alias rows, with both scope checks that must run
   * first: the (level, countryCode, normalizedName) uniqueness pre-check and
   * the cross-group member conflict check.
   *
   * Shared by `create()` and the `canonicalName` half of `merge()` so the two
   * cannot drift — in particular so a merge can never bypass the conflict rule.
   * `client` is the injected PrismaService for `create()` and a transaction
   * client for `merge()`; the read-then-write pair is therefore serialized
   * against a concurrent merge in the merge path.
   */
  private async createGroupWithMembers(
    params: {
      level: LocationGroupLevel;
      countryCode: string;
      canonicalName: string;
      memberValues: string[];
      enabled: boolean;
      notes: string | null;
      geo: { centerLat: number | null; centerLng: number | null; radiusKm: number | null };
      createdById: string | null;
    },
    client: Prisma.TransactionClient | PrismaService,
  ) {
    const { level, countryCode, canonicalName, geo } = params;
    const normalizedName = fold(canonicalName);

    const existing = await client.locationGroup.findUnique({
      where: { level_countryCode_normalizedName: { level, countryCode, normalizedName } },
      select: { id: true, canonicalName: true },
    });
    if (existing) {
      throw this.conflict(
        `A ${level} group named "${existing.canonicalName}" already exists in this scope`,
        existing.id,
        existing.canonicalName,
      );
    }

    // The group's OWN canonical name resolves to itself, so it participates in
    // the conflict check alongside the explicit member values.
    const memberValues = this.dedupeValues([...params.memberValues, canonicalName]);
    await this.assertMembersUnclaimed(level, countryCode, memberValues, null, client);

    return client.locationGroup.create({
      data: {
        level,
        canonicalName,
        normalizedName,
        countryCode,
        enabled: params.enabled,
        notes: params.notes,
        centerLat: geo.centerLat,
        centerLng: geo.centerLng,
        radiusKm: geo.radiusKm,
        createdById: params.createdById,
        aliases: {
          create: memberValues.map((rawValue) => ({
            level,
            countryCode,
            rawValue,
            normalizedValue: fold(rawValue),
          })),
        },
      },
      include: { aliases: { select: { normalizedValue: true } } },
    });
  }

  /**
   * Claim `values` for an existing group: conflict-check, then insert the alias
   * rows. Returns the number of rows actually created.
   *
   * Shared by `addMembers()` and the `targetGroupId` half of `merge()`. Alias
   * rows always carry the GROUP's level and countryCode, never a caller-supplied
   * pair, so an alias can never end up in a scope the resolver would not look in.
   */
  private async attachMembers(
    group: { id: string; level: LocationGroupLevel; countryCode: string },
    values: string[],
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<number> {
    await this.assertMembersUnclaimed(group.level, group.countryCode, values, group.id, client);

    const result = await client.locationGroupAlias.createMany({
      data: values.map((rawValue) => ({
        groupId: group.id,
        level: group.level,
        countryCode: group.countryCode,
        rawValue,
        normalizedValue: fold(rawValue),
      })),
      // A value this group already owns is a no-op, not an error — POSTing the
      // same picker selection twice must be idempotent.
      skipDuplicates: true,
    });

    return result.count;
  }

  /**
   * Drop the resolver snapshot and enqueue a FULL rebuild, returning the job so
   * a caller that wants to report it (see `merge`) can, without any other
   * mutation's behaviour changing.
   *
   * See the class doc for why `groupIds` is never narrowed here.
   */
  private async afterMutation(
    operation: string,
    groupId: string,
  ): Promise<{ id: string; status: string }> {
    this.resolver.invalidate();
    const job = await this.rebuild.enqueueRebuild({});
    this.logger.log(
      `location group ${operation} (${groupId}) invalidated the resolver cache and enqueued rebuild ${job.id}`,
    );
    return { id: job.id, status: job.status };
  }

  private countKey(group: {
    level: LocationGroupLevel;
    canonicalName: string;
    countryCode: string;
  }): string {
    return `${group.level}|${group.countryCode}|${group.canonicalName}`;
  }

  /**
   * Live item counts for a page of groups: ONE `groupBy` per LEVEL present
   * (three at most), never one query per group.
   */
  private async countItemsForGroups(groups: GroupItemCountKey[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (groups.length === 0) return counts;

    const levels = Array.from(new Set(groups.map((g) => g.level)));

    for (const level of levels) {
      const cols = LEVEL_COLUMNS[level];
      const rows = await this.prisma.mediaItem.groupBy({
        by: [cols.canonical, 'geoCountryCode'],
        where: { deletedAt: null, [cols.canonical]: { not: null } },
        _count: { _all: true },
      });

      const levelGroups = groups.filter((g) => g.level === level);

      for (const row of rows as unknown as Array<Record<string, unknown>>) {
        const canonical = row[cols.canonical] as string | null;
        if (!canonical) continue;
        const rowCountry = (row['geoCountryCode'] as string | null) ?? '';
        const count = (row['_count'] as { _all: number })._all;

        for (const group of levelGroups) {
          if (group.canonicalName !== canonical) continue;
          // countryCode '' is UNSCOPED — it counts items from every country.
          if (group.countryCode !== '' && group.countryCode !== rowCountry) continue;
          const key = this.countKey(group);
          counts.set(key, (counts.get(key) ?? 0) + count);
        }
      }
    }

    return counts;
  }

  /**
   * `(countryCode, normalizedValue) → owning group` for one level, covering
   * BOTH explicit aliases and every group's own canonical name (which always
   * resolves to itself, so it is just as claimed as an alias).
   */
  private async loadOwnershipIndex(
    level: LocationGroupLevel,
  ): Promise<Map<string, { groupId: string; canonicalName: string }>> {
    const [aliases, groups] = await Promise.all([
      this.prisma.locationGroupAlias.findMany({
        where: { level },
        select: {
          countryCode: true,
          normalizedValue: true,
          groupId: true,
          group: { select: { canonicalName: true } },
        },
      }),
      this.prisma.locationGroup.findMany({
        where: { level },
        select: { id: true, countryCode: true, normalizedName: true, canonicalName: true },
      }),
    ]);

    const index = new Map<string, { groupId: string; canonicalName: string }>();
    for (const group of groups) {
      index.set(`${group.countryCode}|${group.normalizedName}`, {
        groupId: group.id,
        canonicalName: group.canonicalName,
      });
    }
    for (const alias of aliases) {
      index.set(`${alias.countryCode}|${alias.normalizedValue}`, {
        groupId: alias.groupId,
        canonicalName: alias.group.canonicalName,
      });
    }
    return index;
  }

  /**
   * Scoped lookup first, then the unscoped ('') fallback — the same
   * "more specific wins" order the resolver applies.
   */
  private lookupOwner(
    index: Map<string, { groupId: string; canonicalName: string }>,
    countryCode: string,
    normalizedValue: string,
  ): { groupId: string; canonicalName: string } | undefined {
    return (
      index.get(`${countryCode}|${normalizedValue}`) ??
      (countryCode !== '' ? index.get(`|${normalizedValue}`) : undefined)
    );
  }

  /**
   * A member value that folds to something another group already owns is a
   * `409`, NEVER a silent re-parent: two groups claiming one raw value would
   * make resolution ambiguous, which is exactly what the alias unique index
   * exists to prevent.
   */
  private async assertMembersUnclaimed(
    level: LocationGroupLevel,
    countryCode: string,
    values: string[],
    selfGroupId: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (values.length === 0) return;

    const normalized = Array.from(new Set(values.map((v) => fold(v))));

    const [aliasClashes, groupClashes] = await Promise.all([
      client.locationGroupAlias.findMany({
        where: { level, countryCode, normalizedValue: { in: normalized } },
        select: {
          normalizedValue: true,
          groupId: true,
          group: { select: { canonicalName: true } },
        },
      }),
      client.locationGroup.findMany({
        where: { level, countryCode, normalizedName: { in: normalized } },
        select: { id: true, canonicalName: true, normalizedName: true },
      }),
    ]);

    for (const clash of aliasClashes) {
      if (selfGroupId && clash.groupId === selfGroupId) continue;
      throw this.conflict(
        `"${clash.normalizedValue}" is already a member of "${clash.group.canonicalName}"`,
        clash.groupId,
        clash.group.canonicalName,
      );
    }

    for (const clash of groupClashes) {
      if (selfGroupId && clash.id === selfGroupId) continue;
      throw this.conflict(
        `"${clash.normalizedName}" is already the canonical name of "${clash.canonicalName}"`,
        clash.id,
        clash.canonicalName,
      );
    }
  }

  /**
   * ⚠️ The owning group MUST be reported under `details`.
   *
   * `HttpExceptionFilter` does not spread an exception payload — it REBUILDS
   * every error body from a fixed key allowlist (`message`, `code`, `details`,
   * `error`, `error_description`, `startedAt`). A top-level custom field
   * type-checks, passes any test asserting `err.getResponse()`, and is silently
   * dropped before the client ever sees it. See the `409` gotcha in CLAUDE.md.
   */
  private conflict(message: string, groupId: string, groupName: string): ConflictException {
    return new ConflictException({
      message,
      code: 'LOCATION_GROUP_MEMBER_CONFLICT',
      details: { groupId, groupName },
    });
  }

  /**
   * `center` and `radiusKm` are a PAIR: a centre without a radius (or the
   * reverse) is an area that can never match anything, so it is rejected rather
   * than stored. `radiusKm` is additionally bounded by
   * `locationGrouping.maxRadiusKm`, the same ceiling the resolver clamps to at
   * match time — validating it here turns a silently-clamped surprise into a
   * `400` the admin can see.
   */
  private async validateGeometry(
    center: { lat: number; lng: number } | null,
    radiusKm: number | null,
  ): Promise<{ centerLat: number | null; centerLng: number | null; radiusKm: number | null }> {
    const hasCenter = center !== null && center !== undefined;
    const hasRadius = radiusKm !== null && radiusKm !== undefined;

    if (hasCenter !== hasRadius) {
      throw new BadRequestException(
        'center and radiusKm must be supplied together (or both omitted/cleared)',
      );
    }
    if (!hasCenter || !hasRadius) {
      return { centerLat: null, centerLng: null, radiusKm: null };
    }

    const settings = await this.systemSettings.getSettings();
    const maxRadiusKm = settings.locationGrouping?.maxRadiusKm ?? 50;
    if (radiusKm > maxRadiusKm) {
      throw new BadRequestException(
        `radiusKm ${radiusKm} exceeds locationGrouping.maxRadiusKm (${maxRadiusKm})`,
      );
    }

    return { centerLat: center.lat, centerLng: center.lng, radiusKm };
  }

  /**
   * The cover photo must currently resolve to this group — the same rule the
   * album cover enforces ("must already be a member").
   *
   * Resolution is checked against the group's MEMBER SET rather than the
   * materialised `geo_canonical_*` column, because the rebuild that writes that
   * column is asynchronous: checking the column alone would reject every cover
   * an admin picks in the seconds after creating a group, which is exactly when
   * they pick one. Both the canonical and the raw value are folded, so an
   * item the rebuild has already claimed and one it has not both pass.
   */
  private async assertCoverBelongs(groupId: string, mediaItemId: string): Promise<void> {
    const group = await this.prisma.locationGroup.findUnique({
      where: { id: groupId },
      include: { aliases: { select: { normalizedValue: true } } },
    });
    if (!group) throw new NotFoundException(`Location group ${groupId} not found`);

    const cols = LEVEL_COLUMNS[group.level];

    const item = await this.prisma.mediaItem.findFirst({
      where: { id: mediaItemId, deletedAt: null },
      select: {
        id: true,
        geoCountryCode: true,
        [cols.raw]: true,
        [cols.canonical]: true,
      },
    });
    if (!item) {
      throw new BadRequestException(
        `Cover media item ${mediaItemId} does not exist or has been deleted`,
      );
    }

    const record = item as unknown as Record<string, unknown>;
    const itemCountry = (record['geoCountryCode'] as string | null) ?? '';
    if (group.countryCode !== '' && group.countryCode !== itemCountry) {
      throw new BadRequestException(
        `Cover media item ${mediaItemId} is not in this group's country scope`,
      );
    }

    const owned = new Set(group.aliases.map((a) => a.normalizedValue));
    owned.add(group.normalizedName);

    const candidates = [record[cols.canonical], record[cols.raw]]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((v) => fold(v));

    if (!candidates.some((c) => owned.has(c))) {
      throw new BadRequestException(
        `Cover media item ${mediaItemId} does not resolve to group "${group.canonicalName}"`,
      );
    }
  }

  /** Trim, drop blanks, and collapse fold-duplicates while keeping first spelling. */
  private dedupeValues(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
      const value = raw.trim();
      if (value.length === 0) continue;
      const key = fold(value);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  /** Batch-sign group cover thumbnails through the shared helper. */
  private async signCovers(
    metadatas: Array<Prisma.JsonValue | null>,
  ): Promise<Array<string | null>> {
    if (metadatas.length === 0) return [];
    const withUrls = await this.thumbnails.attachThumbnailUrls(
      metadatas.map((metadata) => ({ metadata })),
    );
    return withUrls.map((entry) => entry.thumbnailUrl);
  }
}
