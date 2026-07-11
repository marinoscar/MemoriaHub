import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, MediaMetadataStatusType } from '@prisma/client';
import { geocodeResultSchema, type GeocodeResult } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { GeoLocationService } from '../media/geo/geo-location.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GeocodeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'geocode';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto. A node fetches
   * transient provider credentials via
   * POST /api/nodes/:id/jobs/:jobId/credentials (NodesService.getJobCredentials)
   * and calls the provider's HTTP API directly — the offline GeoNames
   * dataset provider is not node-eligible (a node declines that job).
   */
  readonly nodeResultSchema = geocodeResultSchema;

  private readonly logger = new Logger(GeocodeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly geoLocationService: GeoLocationService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      this.logger.debug(`Geocode job ${job.id} has no mediaItemId; skipping`);
      return;
    }

    const mediaItemId = job.mediaItemId;

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
      // (with transiently-fetched provider credentials) via
      // @memoriahub/enrichment-compute/geo's fetch*/map* helpers.
      // Number.isFinite above guarantees non-null finite numbers at runtime, but
      // it does not narrow the `number | null` types, so the cast is safe here.
      const computed = await this.computeGeocode(mediaItem.takenLat as number, mediaItem.takenLng as number);

      // PERSIST half — identical whether the result came from this in-process
      // call or a node's POST /nodes/:id/jobs/:jobId/result.
      await this.persistGeocode(job, computed, { id: mediaItem.id, circleId, deletedAt: mediaItem.deletedAt });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Geocode job ${job.id} failed for MediaItem ${mediaItemId}: ${error}`);
      await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.failed, undefined, error);
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
  // against transiently-fetched credentials (see
  // NodesService.getJobCredentials), and submits the resulting DTO directly —
  // bypassing this method and the offline provider entirely (not node-eligible).
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
    job: EnrichmentJob,
    result: GeocodeResult,
    preloadedMediaItem?: { id: string; circleId: string; deletedAt: Date | null },
  ): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('geocode job missing mediaItemId');
    }

    const mediaItem =
      preloadedMediaItem ??
      (await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: { id: true, circleId: true, deletedAt: true },
      }));

    if (!mediaItem || mediaItem.deletedAt) {
      throw new Error(`MediaItem ${job.mediaItemId} not found or deleted`);
    }

    const mediaItemId = mediaItem.id;
    const circleId = mediaItem.circleId;

    const hasData =
      result.country || result.countryCode || result.admin1 || result.admin2 || result.locality || result.placeName;

    if (hasData) {
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
        },
      });

      this.logger.log(
        `Geocode job ${job.id}: geocoded MediaItem ${mediaItemId} via ${result.source}: ${result.country} / ${result.admin1} / ${result.locality}`,
      );
    } else {
      this.logger.debug(`Geocode job ${job.id}: provider returned null for MediaItem ${mediaItemId}`);
    }

    await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.processed, new Date());
  }

  /**
   * Persist a node-computed geocode result (already validated against
   * nodeResultSchema by the ingestion endpoint; re-parsed here for type
   * narrowing, mirroring DuplicateDetectionHandler's precedent).
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = geocodeResultSchema.parse(result);
    await this.persistGeocode(job, parsed);
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
