import { Injectable, Logger } from '@nestjs/common';
import { LocationGroupLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isLocationGroupingEnabled } from '../common/types/settings.types';
import { haversineKm } from '../common/geo/haversine.util';
import { fold } from './normalize-location-name';

/** TTL for the in-memory group/alias snapshot, milliseconds. */
const SNAPSHOT_TTL_MS = 30_000;

/**
 * Raw geocoder columns as stored on a MediaItem — the resolver's input.
 */
export interface RawGeoTiers {
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoAdmin1: string | null;
  geoLocality: string | null;
}

/** The three canonical columns the resolver produces. */
export interface CanonicalGeoTiers {
  geoCanonicalCountry: string | null;
  geoCanonicalAdmin1: string | null;
  geoCanonicalLocality: string | null;
}

/** A group that can claim an item by geographic containment. */
export interface ResolverArea {
  level: LocationGroupLevel;
  countryCode: string;
  canonicalName: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}

export interface ResolverSnapshot {
  /** `${level}|${countryCode}|${normalizedValue}` → canonicalName */
  aliases: Map<string, string>;
  areas: ResolverArea[];
}

/** Build the composite alias-map key. */
export function aliasKey(
  level: LocationGroupLevel,
  countryCode: string,
  normalizedValue: string,
): string {
  return `${level}|${countryCode}|${normalizedValue}`;
}

/**
 * LocationGroupResolverService (issue #373)
 *
 * THE SINGLE component that computes canonical location names. Nothing else in
 * the codebase may derive a `geoCanonical*` value — every write path
 * (applyLocation, persistGeocode, MediaMetadataSyncService, the rebuild
 * handler) delegates here, so there is exactly one definition of what a raw
 * geocoder string canonicalizes to.
 *
 * INVARIANT: whenever a raw tier is non-null, its canonical counterpart is
 * non-null too — the group's `canonicalName` when a group matches, else the
 * raw value VERBATIM. A null raw tier yields a null canonical tier.
 *
 * Per tier, FIRST MATCH WINS:
 *   1. ALIAS  — an admin explicitly listed this raw string under a group.
 *   2. RADIUS — a group with a center + radius geographically contains the
 *               item's coordinates (only when `radiusCaptureEnabled` and
 *               coordinates are present).
 *   3. RAW    — pass through verbatim.
 *
 * ALIAS ALWAYS BEATS RADIUS: an admin who explicitly listed a value expressed a
 * stronger intent than a radius that merely happens to contain the point.
 *
 * Among competing radius areas the SMALLEST radius wins, so a tight
 * "The Woodlands" beats a broad "Greater Houston".
 *
 * When the feature is off (flag or LOCATION_GROUPING_ENABLED=false) resolve()
 * is the IDENTITY FUNCTION — it still writes canonical columns, verbatim, so
 * the invariant holds in both states and disabling the feature is a no-op
 * rebuild away from being fully reverted.
 *
 * Caching mirrors SystemSettingsService's two-layer shape (TTL + explicit
 * invalidate): the dataset is small (hundreds of rows), so the whole enabled
 * group/alias set is loaded in one pass rather than queried per key.
 */
@Injectable()
export class LocationGroupResolverService {
  private readonly logger = new Logger(LocationGroupResolverService.name);

  private snapshotCache: { value: ResolverSnapshot; cachedAt: number } | null = null;

  /** De-duplicates concurrent loads so a cold cache issues ONE query, not N. */
  private inFlight: Promise<ResolverSnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /**
   * Drop the cached snapshot so the very next resolve() sees fresh groups.
   *
   * Called by every group/alias mutation (issue #374) — without it an admin
   * edit would take up to SNAPSHOT_TTL_MS to affect resolution. Mirrors
   * SystemSettingsService.invalidateSettingsCache().
   */
  invalidate(): void {
    this.snapshotCache = null;
    this.inFlight = null;
  }

  /**
   * Load (or reuse) the enabled-group/alias snapshot.
   */
  async getSnapshot(): Promise<ResolverSnapshot> {
    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.cachedAt < SNAPSHOT_TTL_MS) {
      return this.snapshotCache.value;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.loadSnapshot()
      .then((value) => {
        this.snapshotCache = { value, cachedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async loadSnapshot(): Promise<ResolverSnapshot> {
    const groups = await this.prisma.locationGroup.findMany({
      where: { enabled: true },
      select: {
        level: true,
        countryCode: true,
        canonicalName: true,
        centerLat: true,
        centerLng: true,
        radiusKm: true,
        aliases: {
          select: { level: true, countryCode: true, normalizedValue: true },
        },
      },
    });

    const aliases = new Map<string, string>();
    const areas: ResolverArea[] = [];

    for (const group of groups) {
      for (const alias of group.aliases) {
        // The alias unique index (level, countryCode, normalizedValue)
        // guarantees at most one group per key, so a plain set can never lose
        // information here.
        aliases.set(
          aliasKey(alias.level, alias.countryCode, alias.normalizedValue),
          group.canonicalName,
        );
      }

      // A group's own canonical name always resolves to itself, so an item
      // already carrying the canonical spelling is stable without the admin
      // having to alias a group to its own name.
      aliases.set(
        aliasKey(group.level, group.countryCode, fold(group.canonicalName)),
        group.canonicalName,
      );

      if (group.centerLat !== null && group.centerLng !== null && group.radiusKm !== null) {
        areas.push({
          level: group.level,
          countryCode: group.countryCode,
          canonicalName: group.canonicalName,
          centerLat: group.centerLat,
          centerLng: group.centerLng,
          radiusKm: group.radiusKm,
        });
      }
    }

    return { aliases, areas };
  }

  /**
   * Resolve a media item's three raw geo tiers to their canonical counterparts.
   *
   * `coords` is the item's own capture coordinates; pass null when the item has
   * none (radius capture is then impossible and only aliases apply).
   */
  async resolve(
    raw: RawGeoTiers,
    coords: { lat: number; lng: number } | null,
  ): Promise<CanonicalGeoTiers> {
    const settings = await this.systemSettings.getSettings();

    // Feature off ⇒ IDENTITY. Canonical columns are still written (verbatim),
    // preserving the raw-non-null ⇒ canonical-non-null invariant.
    if (!isLocationGroupingEnabled(settings)) {
      return {
        geoCanonicalCountry: raw.geoCountry,
        geoCanonicalAdmin1: raw.geoAdmin1,
        geoCanonicalLocality: raw.geoLocality,
      };
    }

    const snapshot = await this.getSnapshot();

    const radiusCaptureEnabled = settings.locationGrouping?.radiusCaptureEnabled ?? true;
    const maxRadiusKm = settings.locationGrouping?.maxRadiusKm ?? 50;
    const effectiveCoords = radiusCaptureEnabled ? coords : null;

    const countryScope = raw.geoCountryCode ?? '';

    return {
      geoCanonicalCountry: this.resolveTier(
        snapshot,
        LocationGroupLevel.country,
        // Country groups are inherently global — there is no enclosing country
        // to scope them by, so the scope key is always ''.
        '',
        raw.geoCountry,
        effectiveCoords,
        maxRadiusKm,
      ),
      geoCanonicalAdmin1: this.resolveTier(
        snapshot,
        LocationGroupLevel.region,
        countryScope,
        raw.geoAdmin1,
        effectiveCoords,
        maxRadiusKm,
      ),
      geoCanonicalLocality: this.resolveTier(
        snapshot,
        LocationGroupLevel.locality,
        countryScope,
        raw.geoLocality,
        effectiveCoords,
        maxRadiusKm,
      ),
    };
  }

  /**
   * Resolve ONE tier. Exposed for the rebuild handler, which resolves whole
   * columns tier-by-tier rather than item-by-item.
   */
  resolveTier(
    snapshot: ResolverSnapshot,
    level: LocationGroupLevel,
    countryCode: string,
    rawValue: string | null,
    coords: { lat: number; lng: number } | null,
    maxRadiusKm: number,
  ): string | null {
    if (rawValue === null || rawValue === undefined) return null;

    // ---- 1. Alias (always beats radius) ------------------------------------
    const normalized = fold(rawValue);
    const scoped = snapshot.aliases.get(aliasKey(level, countryCode, normalized));
    if (scoped !== undefined) return scoped;

    // A group with countryCode '' is deliberately UNSCOPED — it applies in
    // every country. Checking it only after the exactly-scoped lookup keeps
    // "more specific wins" intact.
    if (countryCode !== '') {
      const unscoped = snapshot.aliases.get(aliasKey(level, '', normalized));
      if (unscoped !== undefined) return unscoped;
    }

    // ---- 2. Radius ---------------------------------------------------------
    if (coords) {
      const area = this.bestArea(snapshot, level, countryCode, coords, maxRadiusKm);
      if (area) return area;
    }

    // ---- 3. Raw, verbatim --------------------------------------------------
    return rawValue;
  }

  /**
   * Smallest-radius containing area for the given level/scope, or null.
   *
   * A group's declared radius is clamped to `maxRadiusKm` so one mis-entered
   * value can't swallow a continent, and the clamped ("effective") radius is
   * what both containment and the smallest-wins ordering use — otherwise two
   * groups clamped to the same effective size would still order by their
   * unclamped declarations.
   */
  private bestArea(
    snapshot: ResolverSnapshot,
    level: LocationGroupLevel,
    countryCode: string,
    coords: { lat: number; lng: number },
    maxRadiusKm: number,
  ): string | null {
    let best: { name: string; radius: number; distance: number } | null = null;

    for (const area of snapshot.areas) {
      if (area.level !== level) continue;
      if (area.countryCode !== '' && area.countryCode !== countryCode) continue;

      const radius = Math.min(area.radiusKm, maxRadiusKm);
      if (!(radius > 0)) continue;

      const distance = haversineKm(coords.lat, coords.lng, area.centerLat, area.centerLng);
      if (distance > radius) continue;

      if (
        best === null ||
        radius < best.radius ||
        // Deterministic tie-breaks so the same inputs always yield the same
        // canonical name regardless of row order.
        (radius === best.radius && distance < best.distance) ||
        (radius === best.radius && distance === best.distance && area.canonicalName < best.name)
      ) {
        best = { name: area.canonicalName, radius, distance };
      }
    }

    return best?.name ?? null;
  }
}
