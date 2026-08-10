import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, LocationGroupLevel, Prisma } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { whereNear } from '../search/media-where.builder';
import { haversineKm } from '../common/geo/haversine.util';
import { fold } from './normalize-location-name';
import {
  LOCATION_GROUP_REBUILD_TYPE,
  LocationGroupRebuildPayload,
} from './location-group-rebuild.service';

/** Keyset page size for the circle sweep and the bbox-candidate scan. */
const PAGE_SIZE = 1000;

/** Chunk size for id-list updateMany calls, bounding parameter-list size. */
const UPDATE_CHUNK = 500;

/**
 * Per-level column mapping. `raw` is the geocoder-owned column (NEVER written
 * by this feature); `canonical` is the derived column this handler maintains.
 */
const LEVEL_COLUMNS: Record<
  LocationGroupLevel,
  { raw: 'geoCountry' | 'geoAdmin1' | 'geoLocality'; canonical: 'geoCanonicalCountry' | 'geoCanonicalAdmin1' | 'geoCanonicalLocality' }
> = {
  country: { raw: 'geoCountry', canonical: 'geoCanonicalCountry' },
  region: { raw: 'geoAdmin1', canonical: 'geoCanonicalAdmin1' },
  locality: { raw: 'geoLocality', canonical: 'geoCanonicalLocality' },
};

/**
 * LocationGroupRebuildHandler — job type `location_group_rebuild` (issue #373).
 *
 * Re-derives `media_items.geo_canonical_*` for the whole library (or one
 * circle) from the current LocationGroup / LocationGroupAlias tables. Enqueued
 * by LocationGroupRebuildService after any group mutation.
 *
 * SERVER-ONLY BY OMISSION: no `nodeResultSchema` / `persistNodeResult` pair, so
 * EnrichmentHandlerRegistry.serverOnlyTypes() picks it up automatically and it
 * becomes ENRICHMENT_WORKER_MODE=system eligible with no explicit pinning —
 * the face_auto_archive_sweep / duplicate_confidence_backfill precedent. There
 * is nothing for a node to do: this is a set-based SQL sweep with no media
 * bytes and no per-item unit of work.
 *
 * ─── Three passes, in this order: RESET → RADIUS → ALIAS ────────────────────
 *
 * The ordering is load-bearing. Because a later pass overwrites an earlier
 * one's claim, running alias LAST makes an alias ALWAYS override a radius claim
 * without the handler having to track per-row provenance — exactly matching
 * LocationGroupResolverService's "alias beats radius" rule, but expressed as
 * statement order rather than per-row branching.
 *
 * Cost scales with the NUMBER OF GROUPS, not the number of media items: a
 * ~70,000-item library rebuilds in one job, because every pass is a handful of
 * set-based statements rather than a per-item loop.
 *
 * NOT FEATURE-GATED, deliberately (the duplicate_confidence_backfill posture).
 * With `features.locationGrouping` off, the resolver is the identity function
 * and this handler's RESET pass alone restores every canonical column to its
 * raw value — which is precisely how disabling the feature takes effect.
 */
@Injectable()
export class LocationGroupRebuildHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = LOCATION_GROUP_REBUILD_TYPE;

  private readonly logger = new Logger(LocationGroupRebuildHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = (job.payload as unknown as LocationGroupRebuildPayload | null) ?? {};
    const circleId = typeof payload.circleId === 'string' ? payload.circleId : null;
    const groupIds =
      Array.isArray(payload.groupIds) && payload.groupIds.length > 0 ? payload.groupIds : null;

    const settings = await this.systemSettings.getSettings();
    const radiusCaptureEnabled = settings.locationGrouping?.radiusCaptureEnabled ?? true;
    const maxRadiusKm = settings.locationGrouping?.maxRadiusKm ?? 50;

    let scanned = 0;
    let updated = 0;
    let groupsApplied = 0;
    let errors = 0;

    // ---- Pass 1: RESET -----------------------------------------------------
    scanned += await this.resetCanonicalColumns(circleId);

    // ---- Passes 2 & 3 ------------------------------------------------------
    const groups = await this.prisma.locationGroup.findMany({
      where: { enabled: true, ...(groupIds ? { id: { in: groupIds } } : {}) },
      select: {
        id: true,
        level: true,
        countryCode: true,
        canonicalName: true,
        centerLat: true,
        centerLng: true,
        radiusKm: true,
        aliases: { select: { id: true, normalizedValue: true, rawValue: true } },
      },
    });

    // Pass 2: RADIUS — claim by geographic containment.
    if (radiusCaptureEnabled) {
      for (const group of groups) {
        if (group.centerLat === null || group.centerLng === null || group.radiusKm === null) {
          continue;
        }
        try {
          updated += await this.applyRadius(
            {
              level: group.level,
              countryCode: group.countryCode,
              canonicalName: group.canonicalName,
              centerLat: group.centerLat,
              centerLng: group.centerLng,
              radiusKm: Math.min(group.radiusKm, maxRadiusKm),
            },
            circleId,
          );
        } catch (err) {
          // A per-group failure is COUNTED, never fatal to the run — one bad
          // group must not strand every other group's canonical names.
          errors++;
          this.logger.warn(
            `location_group_rebuild radius pass failed for group ${group.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // Pass 3: ALIAS — always last, so it overrides any radius claim above.
    for (const group of groups) {
      try {
        updated += await this.applyAliases(group, circleId);
        groupsApplied++;
      } catch (err) {
        errors++;
        this.logger.warn(
          `location_group_rebuild alias pass failed for group ${group.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.logger.log({
      event: 'location_group_rebuild.completed',
      jobId: job.id,
      scanned,
      updated,
      groupsApplied,
      errors,
    });
  }

  // ---------------------------------------------------------------------------
  // Pass 1 — RESET
  // ---------------------------------------------------------------------------

  /**
   * `SET geo_canonical_* = geo_*` for every live item in scope.
   *
   * Chunked per circle (keyset over `circles.id`, 100 at a time — the
   * MemoriesGenerationTask shape) so each statement's lock footprint stays
   * bounded instead of one library-wide UPDATE holding row locks across the
   * entire table.
   *
   * This pass also single-handedly implements "turning the feature off reverts
   * everything": with no groups applied afterwards, every canonical column ends
   * up exactly equal to its raw counterpart.
   */
  private async resetCanonicalColumns(circleId: string | null): Promise<number> {
    let scanned = 0;

    if (circleId) {
      scanned += await this.resetCircle(circleId);
      return scanned;
    }

    let cursor: string | null = null;
    for (;;) {
      const circles: { id: string }[] = await this.prisma.circle.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      if (circles.length === 0) break;
      cursor = circles[circles.length - 1].id;

      for (const circle of circles) {
        scanned += await this.resetCircle(circle.id);
      }

      if (circles.length < 100) break;
    }

    return scanned;
  }

  private async resetCircle(circleId: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE media_items
      SET geo_canonical_country  = geo_country,
          geo_canonical_admin1   = geo_admin1,
          geo_canonical_locality = geo_locality
      WHERE circle_id = ${circleId}::uuid
        AND deleted_at IS NULL
        AND (
          geo_canonical_country  IS DISTINCT FROM geo_country
          OR geo_canonical_admin1   IS DISTINCT FROM geo_admin1
          OR geo_canonical_locality IS DISTINCT FROM geo_locality
        )
    `;
  }

  // ---------------------------------------------------------------------------
  // Pass 2 — RADIUS
  // ---------------------------------------------------------------------------

  /**
   * Claim items inside a group's circle.
   *
   * The cheap lat/lng BOUNDING BOX is the only predicate Prisma can express as
   * real SQL (there is no great-circle operator in `Prisma.WhereInput`), so it
   * is used as a SUPERSET filter and the exact haversine test runs in-process
   * over the bbox hits — the `readTimeRefinement` pattern from the workflow
   * condition compiler, applied to a write.
   *
   * Only items whose raw tier is non-null are claimed: a canonical value must
   * never appear where there is no raw value, or the invariant inverts.
   */
  private async applyRadius(
    area: {
      level: LocationGroupLevel;
      countryCode: string;
      canonicalName: string;
      centerLat: number;
      centerLng: number;
      radiusKm: number;
    },
    circleId: string | null,
  ): Promise<number> {
    if (!(area.radiusKm > 0)) return 0;

    const cols = LEVEL_COLUMNS[area.level];
    const bbox = whereNear(area.centerLat, area.centerLng, area.radiusKm);

    const baseWhere: Prisma.MediaItemWhereInput = {
      ...bbox,
      deletedAt: null,
      [cols.raw]: { not: null },
      ...(circleId ? { circleId } : {}),
      // countryCode '' means UNSCOPED — applies in every country.
      ...(area.countryCode ? { geoCountryCode: area.countryCode } : {}),
    };

    let updated = 0;
    let cursor: string | null = null;

    for (;;) {
      const candidates: { id: string; takenLat: number | null; takenLng: number | null }[] =
        await this.prisma.mediaItem.findMany({
          where: cursor ? { ...baseWhere, id: { gt: cursor } } : baseWhere,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          select: { id: true, takenLat: true, takenLng: true },
        });

      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      // Exact refinement — the bbox is a square around a circle, so its corners
      // are genuinely outside the radius and must be discarded here.
      const matched = candidates
        .filter(
          (c) =>
            c.takenLat !== null &&
            c.takenLng !== null &&
            haversineKm(c.takenLat, c.takenLng, area.centerLat, area.centerLng) <= area.radiusKm,
        )
        .map((c) => c.id);

      for (let i = 0; i < matched.length; i += UPDATE_CHUNK) {
        const res = await this.prisma.mediaItem.updateMany({
          where: { id: { in: matched.slice(i, i + UPDATE_CHUNK) } },
          data: { [cols.canonical]: area.canonicalName },
        });
        updated += res.count;
      }

      if (candidates.length < PAGE_SIZE) break;
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Pass 3 — ALIAS (+ self-healing sweep)
  // ---------------------------------------------------------------------------

  private async applyAliases(
    group: {
      id: string;
      level: LocationGroupLevel;
      countryCode: string;
      canonicalName: string;
      aliases: { id: string; normalizedValue: string; rawValue: string }[];
    },
    circleId: string | null,
  ): Promise<number> {
    const cols = LEVEL_COLUMNS[group.level];

    // A group's own canonical spelling always belongs to it, so items already
    // carrying it are claimed without the admin aliasing a group to its name.
    const rawValues = Array.from(
      new Set([...group.aliases.map((a) => a.rawValue), group.canonicalName]),
    );
    const normalizedByAlias = new Set(group.aliases.map((a) => a.normalizedValue));
    normalizedByAlias.add(fold(group.canonicalName));

    const scopeWhere: Prisma.MediaItemWhereInput = {
      deletedAt: null,
      ...(circleId ? { circleId } : {}),
      ...(group.countryCode ? { geoCountryCode: group.countryCode } : {}),
    };

    let updated = 0;

    // --- Exact-bytes claim: one set-based statement per group ---------------
    const exact = await this.prisma.mediaItem.updateMany({
      where: { ...scopeWhere, [cols.raw]: { in: rawValues } },
      data: { [cols.canonical]: group.canonicalName },
    });
    updated += exact.count;

    // --- Self-healing sweep -------------------------------------------------
    //
    // The `in:` list above matches exact bytes. Real libraries contain
    // case/accent variants an admin never explicitly listed ("SAN JOSE" when
    // the alias says "San José"). Fold every distinct raw value in scope and
    // claim any whose fold matches one of this group's normalized values but
    // whose exact bytes were NOT in the list — then PERSIST those spellings as
    // new alias rows, so the next run's `in:` covers them directly and this
    // sweep converges toward doing nothing.
    const distinct = await this.prisma.mediaItem.groupBy({
      by: [cols.raw],
      where: { ...scopeWhere, [cols.raw]: { not: null } },
    });

    const exactSet = new Set(rawValues);
    const healed: string[] = [];

    for (const row of distinct as unknown as Record<string, string | null>[]) {
      const value = row[cols.raw];
      if (value === null || value === undefined) continue;
      if (exactSet.has(value)) continue;
      if (!normalizedByAlias.has(fold(value))) continue;
      healed.push(value);
    }

    for (const value of healed) {
      const res = await this.prisma.mediaItem.updateMany({
        where: { ...scopeWhere, [cols.raw]: value },
        data: { [cols.canonical]: group.canonicalName },
      });
      updated += res.count;

      // Persist the discovered spelling. `skipDuplicates` keeps a concurrent
      // rebuild (or a raw value that folds into a DIFFERENT group's alias set,
      // which the unique index forbids) from failing the whole pass.
      await this.prisma.locationGroupAlias.createMany({
        data: [
          {
            groupId: group.id,
            level: group.level,
            countryCode: group.countryCode,
            rawValue: value,
            normalizedValue: fold(value),
          },
        ],
        skipDuplicates: true,
      });
    }

    return updated;
  }
}
