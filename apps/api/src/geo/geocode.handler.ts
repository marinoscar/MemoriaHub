import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  RateLimitError as PlatformRateLimitError,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { MediaMetadataStatusType } from '@prisma/client';
import { RateLimitError as LegacyRateLimitError, classifyRateLimit } from '../enrichment/rate-limit.error';
import { geocodeResultSchema, type GeocodeResult } from '@memoriahub/enrichment-compute/dto';
import { GeoLocationService } from '../media/geo/geo-location.service';
import { PrismaService } from '../prisma/prisma.service';
import { LocationGroupResolverService } from '../location-groups/location-group-resolver.service';
import { resolveMediaItemJob, withPlatformRateLimits, type MediaJobContext } from '../platform/jobs/media-item-job';
import { GoogleGeocodeKeyBroker } from './google-geocode-key.broker';

/**
 * `geocode`: a native platform `JobHandler` (RETRO-C6, #600).
 *
 * NODE-ELIGIBLE, with the Google key delivered only through the platform's per-job secret
 * (`nodeSecretBroker`, `POST /api/nodes/:id/jobs/:jobId/secret`): held in node memory for the one job,
 * never persisted (`job_node_secrets` stores a handle). A node computes the reverse lookup itself and
 * submits the shared DTO (`@memoriahub/enrichment-compute/dto`); `persistNodeResult` only writes the
 * geo columns (canonicalised by the location-group resolver) and the status row, and calls no provider.
 * The broker is `usable()` only while the active provider is `google` with a stored key and the
 * `nodes` broker switch (off by default) is on; otherwise the platform withholds `geocode` from nodes
 * and the server runs it, so a missing key or switch never fails a job.
 *
 * Quota signals (Google `OVER_QUERY_LIMIT` / `RESOURCE_EXHAUSTED`, Nominatim 429/5xx) become the platform
 * `RateLimitError`, so the queue defers the job and the status stays `pending`, never `processed` without geo data.
 */
@Injectable()
export class GeocodeHandler implements JobHandler, OnModuleInit {
  readonly type = 'geocode';
  readonly label = 'Geocoding';
  /** One coordinate lookup: a minute covers a slow provider; the throttle gate spaces the calls. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 60_000, maxAttempts: 3 };

  /** The payload a node submits: the shared contract from `@memoriahub/enrichment-compute/dto`. */
  readonly nodeResultSchema = geocodeResultSchema;

  /** The one secret a node may ask for this job: the Google key (see `GoogleGeocodeKeyBroker`). */
  readonly nodeSecretBroker: GoogleGeocodeKeyBroker;

  private readonly logger = new Logger(GeocodeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly geoLocationService: GeoLocationService,
    private readonly prisma: PrismaService,
    private readonly locationGroupResolver: LocationGroupResolverService,
    broker: GoogleGeocodeKeyBroker,
    // App metrics (RETRO-T3, #628): `app.media.geocoded`. Optional for hand-built tests.
    @Optional() private readonly metrics?: AppMetricsService,
  ) {
    this.nodeSecretBroker = broker;
  }

  onModuleInit(): void {
    this.registry.register(this);
    // The geocoder's quota: a cooldown on one geocode job holds the others.
    this.throttle.registerProviderKey(this.type, 'geocode');
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() => this.processMediaItem(context));
  }

  private async processMediaItem(job: MediaJobContext): Promise<void> {
    const mediaItemId = job.mediaItemId as string;

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, takenLat: true, takenLng: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      this.logger.warn(`Geocode job ${job.id}: MediaItem ${mediaItemId} not found or deleted`);
      await this.upsertStatus(mediaItemId, job.circleId ?? '', MediaMetadataStatusType.failed, undefined, 'Media item not found or deleted');
      return;
    }

    const circleId = mediaItem.circleId;

    await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.processing);

    try {
      if (!Number.isFinite(mediaItem.takenLat) || !Number.isFinite(mediaItem.takenLng)) {
        // Skip when coordinates are absent (null) OR non-finite (NaN/Infinity):
        // typeof NaN === 'number' passes a plain null check, so guard with
        // Number.isFinite to stop a bad coordinate reaching the geocoder.
        this.logger.debug(`Geocode job ${job.id}: MediaItem ${mediaItemId} has no usable GPS; marking processed`);
        await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.processed, new Date());
        return;
      }

      // COMPUTE half — same seam a distributed worker node uses locally
      // (with the per-job Google key from the secret broker) via
      // @memoriahub/enrichment-compute/geo's fetch*/map* helpers.
      // Number.isFinite above guarantees non-null finite numbers at runtime, but
      // it does not narrow the `number | null` types, so the cast is safe here.
      const computed = await this.computeGeocode(mediaItem.takenLat as number, mediaItem.takenLng as number);

      // PERSIST half — identical whether the result came from this in-process
      // call or a node's POST /nodes/:id/jobs/:jobId/result.
      await this.persistGeocode(job, computed, {
        id: mediaItem.id,
        circleId,
        deletedAt: mediaItem.deletedAt,
        takenLat: mediaItem.takenLat,
        takenLng: mediaItem.takenLng,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A quota signal defers the job (the queue re-runs it): the item is still waiting, not failed.
      const deferred =
        err instanceof PlatformRateLimitError || err instanceof LegacyRateLimitError || classifyRateLimit(err) !== null;
      if (deferred) this.logger.warn(`Geocode job ${job.id} deferred for MediaItem ${mediaItemId}: ${error}`);
      else this.logger.error(`Geocode job ${job.id} failed for MediaItem ${mediaItemId}: ${error}`);
      await this.upsertStatus(
        mediaItemId,
        circleId,
        deferred ? MediaMetadataStatusType.pending : MediaMetadataStatusType.failed,
        undefined,
        error,
      );
      // The provider is resolved inside the geo service, so a failed lookup reports it as `other`.
      this.metrics?.add('mediaGeocoded', 1, { provider: 'other', outcome: deferred ? 'deferred' : 'failed' });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // computeGeocode — COMPUTE half of the split.
  //
  // Delegates to GeoLocationService.reverseGeocode (which resolves the active
  // provider from system settings) and flattens its return into the
  // node-result DTO shape. A distributed worker node runs the equivalent
  // lookup locally via @memoriahub/enrichment-compute/geo's
  // fetchNominatim/fetchGoogleReverse + mapNominatimResponse/mapGoogleResponse
  // against the per-job Google key (see GoogleGeocodeKeyBroker), and submits
  // the resulting DTO directly — bypassing this method.
  // ---------------------------------------------------------------------------

  async computeGeocode(lat: number, lng: number): Promise<GeocodeResult> {
    const { result, source } = await this.geoLocationService.reverseGeocode(lat, lng);
    return {
      country: result?.country ?? null,
      countryCode: result?.countryCode ?? null,
      admin1: result?.admin1 ?? null,
      admin2: result?.admin2 ?? null,
      locality: result?.locality ?? null,
      placeName: result?.placeName ?? null,
      source,
    };
  }

  // ---------------------------------------------------------------------------
  // persistGeocode — PERSIST half of the split.
  //
  // Writes the geo* columns + geocodedAt + media_geocode_status. Accepts an
  // optional preloaded MediaItem (used by process() above to avoid a
  // redundant query); the node-result path (persistNodeResult) has no
  // preloaded context and reloads it fresh.
  // ---------------------------------------------------------------------------

  async persistGeocode(
    job: MediaJobContext,
    result: GeocodeResult,
    preloadedMediaItem?: {
      id: string;
      circleId: string;
      deletedAt: Date | null;
      takenLat: number | null;
      takenLng: number | null;
    },
  ): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('geocode job missing mediaItemId');
    }

    const mediaItem =
      preloadedMediaItem ??
      (await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          circleId: true,
          deletedAt: true,
          takenLat: true,
          takenLng: true,
        },
      }));

    if (!mediaItem || mediaItem.deletedAt) {
      throw new Error(`MediaItem ${job.mediaItemId} not found or deleted`);
    }

    const mediaItemId = mediaItem.id;
    const circleId = mediaItem.circleId;

    const hasData =
      result.country || result.countryCode || result.admin1 || result.admin2 || result.locality || result.placeName;

    if (hasData) {
      // Location Grouping (issue #373): canonicalize in the SAME update as the
      // raw columns, so the two halves can never be transiently inconsistent.
      //
      // ⚠️ This handler is OVERWRITE-ALL (every geo column, including absent
      // tiers -> null) — deliberately unlike MediaMetadataSyncService's
      // present-only semantics. Both write canonical columns using their OWN
      // existing semantics; do NOT unify them.
      //
      // This overwrite-all behavior is precisely WHY canonical names get their
      // own columns: a canonical name written into geo_admin1 would be silently
      // reverted here on the next re-geocode. The raw columns stay untouched by
      // the grouping feature.
      const canonical = await this.locationGroupResolver.resolve(
        {
          geoCountry: result.country ?? null,
          geoCountryCode: result.countryCode ?? null,
          geoAdmin1: result.admin1 ?? null,
          geoLocality: result.locality ?? null,
        },
        mediaItem.takenLat !== null && mediaItem.takenLng !== null
          ? { lat: mediaItem.takenLat, lng: mediaItem.takenLng }
          : null,
      );

      await this.prisma.mediaItem.update({
        where: { id: mediaItemId },
        data: {
          geoCountry: result.country ?? null,
          geoCountryCode: result.countryCode ?? null,
          geoAdmin1: result.admin1 ?? null,
          geoAdmin2: result.admin2 ?? null,
          geoLocality: result.locality ?? null,
          geoPlaceName: result.placeName ?? null,
          geoSource: result.source,
          geocodedAt: new Date(),
          ...canonical,
        },
      });

      this.logger.log(
        `Geocode job ${job.id}: geocoded MediaItem ${mediaItemId} via ${result.source}: ${result.country} / ${result.admin1} / ${result.locality}`,
      );
    } else {
      this.logger.debug(`Geocode job ${job.id}: provider returned null for MediaItem ${mediaItemId}`);
    }

    await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.processed, new Date());
    this.metrics?.add('mediaGeocoded', 1, {
      // `geonames-offline` is the offline provider; `none` (no provider resolved) reads as `other`.
      provider: result.source === 'geonames-offline' ? 'offline' : result.source,
      outcome: hasData ? 'resolved' : 'no_result',
    });
  }

  /**
   * Persist a node-computed geocode result (already validated against
   * nodeResultSchema by the ingestion endpoint; re-parsed here for type
   * narrowing, mirroring DuplicateDetectionHandler's precedent).
   */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed = geocodeResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.persistGeocode(context, parsed);
  }

  private async upsertStatus(
    mediaItemId: string,
    circleId: string,
    status: MediaMetadataStatusType,
    processedAt?: Date,
    lastError?: string,
  ): Promise<void> {
    await this.prisma.mediaGeocodeStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status,
        processedAt: processedAt ?? null,
        lastError: lastError ?? null,
      },
      update: {
        status,
        ...(processedAt !== undefined && { processedAt }),
        ...(lastError !== undefined ? { lastError } : { lastError: null }),
      },
    });
  }
}
