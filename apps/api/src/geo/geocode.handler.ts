import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, MediaMetadataStatusType } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { GeoLocationService } from '../media/geo/geo-location.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GeocodeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'geocode';
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

      // Number.isFinite above guarantees non-null finite numbers at runtime, but
      // it does not narrow the `number | null` types, so the cast is safe here.
      const { result, source } = await this.geoLocationService.reverseGeocode(
        mediaItem.takenLat as number,
        mediaItem.takenLng as number,
      );

      if (result) {
        await this.prisma.mediaItem.update({
          where: { id: mediaItemId },
          data: {
            geoCountry: result.country ?? null,
            geoCountryCode: result.countryCode ?? null,
            geoAdmin1: result.admin1 ?? null,
            geoAdmin2: result.admin2 ?? null,
            geoLocality: result.locality ?? null,
            geoPlaceName: result.placeName ?? null,
            geoSource: source,
            geocodedAt: new Date(),
          },
        });

        this.logger.log(
          `Geocode job ${job.id}: geocoded MediaItem ${mediaItemId} via ${source}: ${result.country} / ${result.admin1} / ${result.locality}`,
        );
      } else {
        this.logger.debug(`Geocode job ${job.id}: provider returned null for MediaItem ${mediaItemId}`);
      }

      await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.processed, new Date());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Geocode job ${job.id} failed for MediaItem ${mediaItemId}: ${error}`);
      await this.upsertStatus(mediaItemId, circleId, MediaMetadataStatusType.failed, undefined, error);
      throw err;
    }
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
