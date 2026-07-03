import { Injectable, Logger } from '@nestjs/common';
import { JobReason, LocationSuggestionStatus, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { DEFAULT_SYSTEM_SETTINGS, SystemSettingsValue } from '../common/types/settings.types';

export type LocationInferenceConfig = NonNullable<SystemSettingsValue['locationInference']>;

const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Pure computation helpers (exported for reuse/testability)
// ---------------------------------------------------------------------------

export interface AnchorPoint {
  id: string;
  capturedAt: Date;
  lat: number;
  lng: number;
}

export interface ComputedLocationSuggestion {
  lat: number;
  lng: number;
  confidence: number;
  method: 'interpolated' | 'nearest';
  anchorBeforeId: string | null;
  anchorAfterId: string | null;
  gapBeforeSeconds: number | null;
  gapAfterSeconds: number | null;
  anchorDistanceKm: number | null;
  impliedSpeedKmh: number | null;
  autoApplyEligible: boolean;
}

/** Great-circle distance between two lat/lng points, in kilometers. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Antimeridian-safe time-weighted longitude interpolation.
 * When the two longitudes are more than 180 degrees apart, the "short way
 * around" crosses +/-180 — normalize one side by +/-360 before interpolating,
 * then wrap the result back into [-180, 180].
 */
function interpolateLng(lng1: number, lng2: number, w: number): number {
  let a = lng1;
  let b = lng2;
  if (Math.abs(b - a) > 180) {
    if (a < b) a += 360;
    else b += 360;
  }
  let result = a + (b - a) * w;
  while (result > 180) result -= 360;
  while (result < -180) result += 360;
  return result;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * computeLocationSuggestion
 *
 * Pure function implementing the per-item location-inference algorithm:
 *   - Two anchors, agreeing (<= maxAnchorDistanceKm): time-weighted interpolation.
 *   - Two anchors, disagreeing: nearer-in-time anchor's coords, confidence capped at 0.5.
 *     (method stays 'interpolated' — this is a fallback within the two-anchor case,
 *     not a distinct extrapolation.)
 *   - One anchor within maxExtrapolationGapMinutes: that anchor's coords, method 'nearest'.
 *   - Zero anchors, or single anchor beyond maxExtrapolationGapMinutes: null (no-op).
 *
 * `deviceMatchGuaranteed` must be true only when the caller filtered anchors to the
 * SAME cameraMake/cameraModel as the target — auto-apply is never eligible otherwise,
 * per the "never auto-apply a cross-device inference" rule.
 */
export function computeLocationSuggestion(
  targetCapturedAt: Date,
  anchorBefore: AnchorPoint | null,
  anchorAfter: AnchorPoint | null,
  cfg: LocationInferenceConfig,
  deviceMatchGuaranteed: boolean,
): ComputedLocationSuggestion | null {
  if (anchorBefore && anchorAfter) {
    const gapBeforeSeconds = Math.max(
      0,
      Math.round((targetCapturedAt.getTime() - anchorBefore.capturedAt.getTime()) / 1000),
    );
    const gapAfterSeconds = Math.max(
      0,
      Math.round((anchorAfter.capturedAt.getTime() - targetCapturedAt.getTime()) / 1000),
    );
    const D = haversineKm(anchorBefore.lat, anchorBefore.lng, anchorAfter.lat, anchorAfter.lng);
    const gapHours = (gapBeforeSeconds + gapAfterSeconds) / 3600;
    // Zero/near-zero gap => speed = 0 (explicit guard against division by zero).
    const impliedSpeedKmh = gapHours > 0 ? D / gapHours : 0;

    const agree = D <= cfg.maxAnchorDistanceKm;

    let lat: number;
    let lng: number;
    if (agree) {
      const totalGap = gapBeforeSeconds + gapAfterSeconds;
      // Time-weighted toward the closer anchor: w is the fraction of the way
      // from anchorBefore to anchorAfter that the target's capture time sits at.
      const w = totalGap > 0 ? gapBeforeSeconds / totalGap : 0.5;
      lat = anchorBefore.lat + (anchorAfter.lat - anchorBefore.lat) * w;
      lng = interpolateLng(anchorBefore.lng, anchorAfter.lng, w);
    } else {
      // Disagreement fallback: anchors are more than maxAnchorDistanceKm apart,
      // so trust the nearer-in-time anchor's coords instead of interpolating.
      const useBefore = gapBeforeSeconds <= gapAfterSeconds;
      lat = useBefore ? anchorBefore.lat : anchorAfter.lat;
      lng = useBefore ? anchorBefore.lng : anchorAfter.lng;
    }

    const maxGapUsedMinutes = Math.max(gapBeforeSeconds, gapAfterSeconds) / 60;
    const timeFactor = clamp01(1 - maxGapUsedMinutes / cfg.maxGapMinutes);
    const agreeFactor = 1 - Math.min(D / cfg.maxAnchorDistanceKm, 1);
    const speedFactor = Math.max(0, 1 - impliedSpeedKmh / cfg.maxImpliedSpeedKmh);

    let confidence = clamp01(0.5 * timeFactor + 0.3 * agreeFactor + 0.2 * speedFactor);

    const speedExceeded = impliedSpeedKmh > cfg.maxImpliedSpeedKmh;
    if (!agree) confidence = Math.min(confidence, 0.5);
    if (speedExceeded) confidence = Math.min(confidence, 0.4);

    const autoApplyEligible =
      deviceMatchGuaranteed &&
      gapBeforeSeconds / 60 <= cfg.autoApplyMaxGapMinutes &&
      gapAfterSeconds / 60 <= cfg.autoApplyMaxGapMinutes &&
      agree &&
      !speedExceeded;

    return {
      lat,
      lng,
      confidence,
      method: 'interpolated',
      anchorBeforeId: anchorBefore.id,
      anchorAfterId: anchorAfter.id,
      gapBeforeSeconds,
      gapAfterSeconds,
      anchorDistanceKm: D,
      impliedSpeedKmh,
      autoApplyEligible,
    };
  }

  const single = anchorBefore ?? anchorAfter;
  if (!single) return null; // zero anchors

  const isBefore = single === anchorBefore;
  const gapSeconds = Math.max(
    0,
    Math.round(Math.abs(targetCapturedAt.getTime() - single.capturedAt.getTime()) / 1000),
  );
  const gapMinutes = gapSeconds / 60;
  // Extrapolating beyond a single point is less safe than interpolating between
  // two — use the tighter maxExtrapolationGapMinutes bound (mirrors ExifTool's
  // GeoMaxIntSecs vs GeoMaxExtSecs split).
  if (gapMinutes > cfg.maxExtrapolationGapMinutes) {
    return null;
  }

  const timeFactor = clamp01(1 - gapMinutes / cfg.maxGapMinutes);
  // Single-anchor case uses fixed agree/speed factors (0.25 / 0.5) — there is
  // no second anchor to agree/disagree with, and no speed to compute.
  const confidence = clamp01(0.5 * timeFactor + 0.3 * 0.25 + 0.2 * 0.5);

  return {
    lat: single.lat,
    lng: single.lng,
    confidence,
    method: 'nearest',
    anchorBeforeId: isBefore ? single.id : null,
    anchorAfterId: isBefore ? null : single.id,
    gapBeforeSeconds: isBefore ? gapSeconds : null,
    gapAfterSeconds: isBefore ? null : gapSeconds,
    anchorDistanceKm: null,
    impliedSpeedKmh: null,
    // Extrapolation (single anchor) never auto-applies — the auto-apply gate
    // requires two device-matched anchors, full stop.
    autoApplyEligible: false,
  };
}

interface SweepRow {
  id: string;
  capturedAt: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
  takenLat: number | null;
  takenLng: number | null;
  coordSource: string | null;
}

interface SweepTarget {
  mediaItemId: string;
  computed: ComputedLocationSuggestion;
}

export interface SweepSummary {
  targets: number;
  autoApplied: number;
  pending: number;
  skipped: number;
  elapsedMs: number;
}

@Injectable()
export class LocationInferenceService {
  private readonly logger = new Logger(LocationInferenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  private async getConfig(): Promise<LocationInferenceConfig> {
    const settings = await this.systemSettings.getSettings();
    return settings.locationInference ?? (DEFAULT_SYSTEM_SETTINGS.locationInference as LocationInferenceConfig);
  }

  // ---------------------------------------------------------------------------
  // Per-item inference
  // ---------------------------------------------------------------------------

  /**
   * inferForItem
   *
   * Infers (or re-infers, when forceRerun=true) a location suggestion for a
   * single media item lacking GPS. No-ops silently (no suggestion row written)
   * when the item is ineligible — see the guard checks below.
   */
  async inferForItem(mediaItemId: string, forceRerun = false): Promise<void> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        type: true,
        deletedAt: true,
        circleId: true,
        takenLat: true,
        capturedAt: true,
        cameraMake: true,
        cameraModel: true,
      },
    });

    if (!item || item.deletedAt || item.type !== MediaType.photo || item.takenLat !== null || !item.capturedAt) {
      return;
    }

    if (!forceRerun) {
      const existing = await this.prisma.locationSuggestion.findUnique({
        where: { mediaItemId },
        select: { status: true },
      });
      if (existing?.status === LocationSuggestionStatus.rejected) {
        return; // Preserve user rejection unless this is an explicit rerun.
      }
    }

    const cfg = await this.getConfig();

    const hasDeviceInfo = !!(item.cameraMake || item.cameraModel);
    if (cfg.requireSameDevice && !hasDeviceInfo) {
      return; // Not inferable without a device to match anchors against.
    }

    const deviceFilter: Prisma.MediaItemWhereInput = cfg.requireSameDevice
      ? { cameraMake: item.cameraMake, cameraModel: item.cameraModel }
      : {};

    const maxGapMs = cfg.maxGapMinutes * 60_000;
    const anchorSelect = { id: true, capturedAt: true, takenLat: true, takenLng: true } as const;
    const anchorWhereBase: Prisma.MediaItemWhereInput = {
      circleId: item.circleId,
      type: MediaType.photo,
      deletedAt: null,
      // NEVER chain an inference off another inference — drift-prevention rule.
      coordSource: { in: ['exif', 'manual'] },
      ...deviceFilter,
    };

    const [anchorBeforeRow, anchorAfterRow] = await Promise.all([
      this.prisma.mediaItem.findFirst({
        where: {
          ...anchorWhereBase,
          capturedAt: { lt: item.capturedAt, gte: new Date(item.capturedAt.getTime() - maxGapMs) },
        },
        orderBy: { capturedAt: 'desc' },
        select: anchorSelect,
      }),
      this.prisma.mediaItem.findFirst({
        where: {
          ...anchorWhereBase,
          capturedAt: { gt: item.capturedAt, lte: new Date(item.capturedAt.getTime() + maxGapMs) },
        },
        orderBy: { capturedAt: 'asc' },
        select: anchorSelect,
      }),
    ]);

    const toAnchorPoint = (row: typeof anchorBeforeRow): AnchorPoint | null =>
      row && row.takenLat != null && row.takenLng != null
        ? { id: row.id, capturedAt: row.capturedAt!, lat: row.takenLat, lng: row.takenLng }
        : null;

    // Only device-filtered queries guarantee the found anchors truly share the
    // target's device — when requireSameDevice=false we don't filter by device
    // at all, so auto-apply must never be considered eligible for this item.
    const deviceMatchGuaranteed = cfg.requireSameDevice;

    const computed = computeLocationSuggestion(
      item.capturedAt,
      toAnchorPoint(anchorBeforeRow),
      toAnchorPoint(anchorAfterRow),
      cfg,
      deviceMatchGuaranteed,
    );

    if (!computed) return;

    await this.applyComputedSuggestion(item.id, item.circleId, computed);
  }

  private async applyComputedSuggestion(
    mediaItemId: string,
    circleId: string,
    computed: ComputedLocationSuggestion,
  ): Promise<void> {
    const suggestionFields = {
      lat: computed.lat,
      lng: computed.lng,
      confidence: computed.confidence,
      method: computed.method,
      anchorBeforeId: computed.anchorBeforeId,
      anchorAfterId: computed.anchorAfterId,
      gapBeforeSeconds: computed.gapBeforeSeconds,
      gapAfterSeconds: computed.gapAfterSeconds,
      anchorDistanceKm: computed.anchorDistanceKm,
      impliedSpeedKmh: computed.impliedSpeedKmh,
    };

    if (computed.autoApplyEligible) {
      await this.prisma.$transaction([
        this.prisma.mediaItem.update({
          where: { id: mediaItemId },
          data: { takenLat: computed.lat, takenLng: computed.lng, coordSource: 'inferred' },
        }),
        this.prisma.locationSuggestion.upsert({
          where: { mediaItemId },
          create: {
            mediaItemId,
            circleId,
            ...suggestionFields,
            status: LocationSuggestionStatus.auto_applied,
          },
          update: {
            ...suggestionFields,
            status: LocationSuggestionStatus.auto_applied,
            resolvedById: null,
            resolvedAt: null,
          },
        }),
        // System-initiated action — no human resolvedById/actorUserId (there is
        // no existing precedent for a "system actor" audit convention in this
        // codebase; actorUserId is nullable specifically for cases like this).
        this.prisma.auditEvent.create({
          data: {
            actorUserId: null,
            action: 'media:location_inferred',
            targetType: 'media_item',
            targetId: mediaItemId,
            meta: { ...suggestionFields } as Prisma.InputJsonValue,
          },
        }),
      ]);

      await this.enrichmentJobService.enqueue({
        type: 'geocode',
        mediaItemId,
        circleId,
        reason: JobReason.rerun,
        priority: 0,
      });

      this.logger.log(
        `Auto-applied location inference for MediaItem ${mediaItemId} (confidence=${computed.confidence.toFixed(2)})`,
      );
      return;
    }

    await this.prisma.locationSuggestion.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        ...suggestionFields,
        status: LocationSuggestionStatus.pending,
      },
      update: {
        ...suggestionFields,
        status: LocationSuggestionStatus.pending,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sweep (circle-wide backfill pass)
  // ---------------------------------------------------------------------------

  /**
   * sweepCircle
   *
   * Loads a narrow projection of the ENTIRE circle's photos (no date filter on
   * the load — anchors just outside [from,to] must still be able to anchor
   * targets inside the range), walks it in-memory to compute suggestions for
   * every eligible GPS-less target, then writes results in 500-item chunks.
   *
   * CRITICAL invariant: the walk reads ONLY the preloaded snapshot array and
   * never mutates it. Items auto-applied earlier in the walk must not become
   * "real" anchors for a later item in the SAME walk — this function achieves
   * that trivially by computing the entire in-memory `results` set BEFORE any
   * database write happens (the write loop runs strictly after the walk).
   */
  async sweepCircle(
    circleId: string,
    opts: { from?: string; to?: string; force?: boolean },
  ): Promise<SweepSummary> {
    const start = Date.now();
    const cfg = await this.getConfig();
    const force = opts.force ?? false;
    const fromDate = opts.from ? new Date(opts.from) : null;
    const toDate = opts.to ? new Date(opts.to) : null;

    const rows = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        type: MediaType.photo,
        deletedAt: null,
        capturedAt: { not: null },
      },
      select: {
        id: true,
        capturedAt: true,
        cameraMake: true,
        cameraModel: true,
        takenLat: true,
        takenLng: true,
        coordSource: true,
      },
      orderBy: [{ cameraMake: 'asc' }, { cameraModel: 'asc' }, { capturedAt: 'asc' }],
    });

    const existingSuggestionIds = force
      ? new Set<string>()
      : new Set(
          (
            await this.prisma.locationSuggestion.findMany({
              where: { circleId },
              select: { mediaItemId: true },
            })
          ).map((s) => s.mediaItemId),
        );

    const isAnchor = (row: SweepRow): boolean =>
      row.takenLat != null &&
      row.takenLng != null &&
      (row.coordSource === 'exif' || row.coordSource === 'manual');

    const isTargetBase = (row: SweepRow): boolean =>
      row.takenLat === null &&
      row.capturedAt !== null &&
      (!fromDate || row.capturedAt >= fromDate) &&
      (!toDate || row.capturedAt <= toDate) &&
      (force || !existingSuggestionIds.has(row.id));

    const results: SweepTarget[] = [];
    const handledIds = new Set<string>();
    let skipped = 0;

    // --- Pass 1: same-device two-pointer walk, grouped by adjacent
    // (cameraMake, cameraModel) tuples (the array is already sorted that way).
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (
        j < rows.length &&
        rows[j].cameraMake === rows[i].cameraMake &&
        rows[j].cameraModel === rows[i].cameraModel
      ) {
        j++;
      }
      const hasDevice = !!(rows[i].cameraMake || rows[i].cameraModel);
      if (hasDevice) {
        const group = rows.slice(i, j);
        this.walkGroup(group, cfg, true, results, handledIds, isTargetBase, isAnchor, (n) => {
          skipped += n;
        });
      } else {
        // Null-device rows are not walked in pass 1 — matching two
        // "unknown device" items as if they were the same camera is unsound.
      }
      i = j;
    }

    // --- Pass 2: cross-device, suggestion-only, only when requireSameDevice=false.
    if (!cfg.requireSameDevice) {
      const crossDeviceRows = [...rows].sort(
        (a, b) => (a.capturedAt?.getTime() ?? 0) - (b.capturedAt?.getTime() ?? 0),
      );
      const targetNotHandled = (row: SweepRow) => isTargetBase(row) && !handledIds.has(row.id);
      this.walkGroup(crossDeviceRows, cfg, false, results, handledIds, targetNotHandled, isAnchor, (n) => {
        skipped += n;
      });
    }

    // --- Chunked writes.
    let autoApplied = 0;
    let pendingCount = 0;
    for (let k = 0; k < results.length; k += CHUNK_SIZE) {
      const chunk = results.slice(k, k + CHUNK_SIZE);
      const chunkIds = chunk.map((r) => r.mediaItemId);
      const autoApplyChunk = chunk.filter((r) => r.computed.autoApplyEligible);

      await this.prisma.$transaction(async (tx) => {
        // Clear stale suggestions being replaced. `force=false` results never
        // include a target that already has ANY row (see isTargetBase), so this
        // only ever fires meaningfully when force=true — which also needs to
        // clear 'rejected' rows (not just 'pending') since mediaItemId is
        // unique on LocationSuggestion and createMany would otherwise conflict.
        await tx.locationSuggestion.deleteMany({
          where: {
            mediaItemId: { in: chunkIds },
            status: force
              ? { in: [LocationSuggestionStatus.pending, LocationSuggestionStatus.rejected] }
              : LocationSuggestionStatus.pending,
          },
        });

        await tx.locationSuggestion.createMany({
          data: chunk.map((r) => ({
            mediaItemId: r.mediaItemId,
            circleId,
            lat: r.computed.lat,
            lng: r.computed.lng,
            confidence: r.computed.confidence,
            method: r.computed.method,
            anchorBeforeId: r.computed.anchorBeforeId,
            anchorAfterId: r.computed.anchorAfterId,
            gapBeforeSeconds: r.computed.gapBeforeSeconds,
            gapAfterSeconds: r.computed.gapAfterSeconds,
            anchorDistanceKm: r.computed.anchorDistanceKm,
            impliedSpeedKmh: r.computed.impliedSpeedKmh,
            status: r.computed.autoApplyEligible
              ? LocationSuggestionStatus.auto_applied
              : LocationSuggestionStatus.pending,
          })),
        });

        for (const r of autoApplyChunk) {
          await tx.mediaItem.update({
            where: { id: r.mediaItemId },
            data: { takenLat: r.computed.lat, takenLng: r.computed.lng, coordSource: 'inferred' },
          });
        }

        if (autoApplyChunk.length > 0) {
          await tx.auditEvent.createMany({
            data: autoApplyChunk.map((r) => ({
              actorUserId: null,
              action: 'media:location_inferred',
              targetType: 'media_item',
              targetId: r.mediaItemId,
              meta: {
                lat: r.computed.lat,
                lng: r.computed.lng,
                confidence: r.computed.confidence,
                method: r.computed.method,
                gapBeforeSeconds: r.computed.gapBeforeSeconds,
                gapAfterSeconds: r.computed.gapAfterSeconds,
                anchorDistanceKm: r.computed.anchorDistanceKm,
                impliedSpeedKmh: r.computed.impliedSpeedKmh,
                sweep: true,
              } as Prisma.InputJsonValue,
            })),
          });
        }
      });

      // Enqueue geocode jobs AFTER the transaction commits — never inside it,
      // since job enqueue is a separate table and a rolled-back coord write
      // must not leave an orphaned geocode job behind.
      for (const r of autoApplyChunk) {
        await this.enrichmentJobService.enqueue({
          type: 'geocode',
          mediaItemId: r.mediaItemId,
          circleId,
          reason: JobReason.backfill,
          priority: 100,
        });
      }

      autoApplied += autoApplyChunk.length;
      pendingCount += chunk.length - autoApplyChunk.length;
    }

    const elapsedMs = Date.now() - start;
    this.logger.log(
      `Location-inference sweep complete for circle ${circleId}: targets=${results.length} autoApplied=${autoApplied} pending=${pendingCount} skipped=${skipped} elapsedMs=${elapsedMs}`,
    );

    return { targets: results.length, autoApplied, pending: pendingCount, skipped, elapsedMs };
  }

  /**
   * walkGroup — true two-pointer walk over a capturedAt-sorted row array.
   * Precomputes, in one backward pass, the nearest anchor at-or-after each
   * index; a single forward pass then tracks the nearest anchor at-or-before
   * the current position. Never mutates `group` — reads only the original
   * snapshot values loaded by the caller (the snapshot invariant).
   */
  private walkGroup(
    group: SweepRow[],
    cfg: LocationInferenceConfig,
    deviceMatchGuaranteed: boolean,
    results: SweepTarget[],
    handledIds: Set<string>,
    isTarget: (row: SweepRow) => boolean,
    isAnchor: (row: SweepRow) => boolean,
    onSkip: (count: number) => void,
  ): void {
    const n = group.length;
    if (n === 0) return;

    const nextAnchorIdx = new Array<number>(n).fill(-1);
    let next = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (isAnchor(group[i])) next = i;
      nextAnchorIdx[i] = next;
    }

    const maxGapMs = cfg.maxGapMinutes * 60_000;
    let lastAnchorIdx = -1;
    let skippedHere = 0;

    for (let i = 0; i < n; i++) {
      const row = group[i];
      if (isAnchor(row)) {
        lastAnchorIdx = i;
        continue;
      }
      if (handledIds.has(row.id) || !isTarget(row) || !row.capturedAt) {
        continue;
      }

      const beforeIdx = lastAnchorIdx;
      const afterIdx = i + 1 < n ? nextAnchorIdx[i + 1] : -1;

      let anchorBeforeRow = beforeIdx >= 0 ? group[beforeIdx] : null;
      let anchorAfterRow = afterIdx >= 0 ? group[afterIdx] : null;

      if (
        anchorBeforeRow &&
        anchorBeforeRow.capturedAt &&
        row.capturedAt.getTime() - anchorBeforeRow.capturedAt.getTime() > maxGapMs
      ) {
        anchorBeforeRow = null;
      }
      if (
        anchorAfterRow &&
        anchorAfterRow.capturedAt &&
        anchorAfterRow.capturedAt.getTime() - row.capturedAt.getTime() > maxGapMs
      ) {
        anchorAfterRow = null;
      }

      const toAnchorPoint = (r: SweepRow | null): AnchorPoint | null =>
        r && r.capturedAt && r.takenLat != null && r.takenLng != null
          ? { id: r.id, capturedAt: r.capturedAt, lat: r.takenLat, lng: r.takenLng }
          : null;

      const computed = computeLocationSuggestion(
        row.capturedAt,
        toAnchorPoint(anchorBeforeRow),
        toAnchorPoint(anchorAfterRow),
        cfg,
        deviceMatchGuaranteed,
      );

      if (!computed) {
        skippedHere++;
        continue;
      }

      handledIds.add(row.id);
      results.push({ mediaItemId: row.id, computed });
    }

    onSkip(skippedHere);
  }
}
