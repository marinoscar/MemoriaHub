import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { GeoLocationService } from '../../../media/geo/geo-location.service';
import { GeoLocationResult } from '../../../media/geo/geo-location-provider.interface';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExifrModule = { parse: (src: Buffer, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> };

async function getExifr(): Promise<ExifrModule> {
  const mod = await import('exifr');
  return (mod.default ?? mod) as unknown as ExifrModule;
}

/**
 * ReverseGeocodeProcessor — reverse-geocodes the GPS coordinates of a photo or
 * a video.
 *
 * Name:     geocode
 * Priority: 30  (after exif and video-probe at 20)
 * Handles:  image/* and video/* MIME types
 *
 * Photos: SELF-CONTAINED per Constraint A — this processor does NOT read
 * ExifProcessor output; it independently re-extracts GPS tags from the image
 * buffer using exifr (GPS-only parse).
 *
 * Videos (issue #545): coordinates come from the container's ISO 6709 location
 * tag, which VideoProbeProcessor (priority 20) has already parsed into
 * `priorResults['video-probe'].latitude/longitude`. They are read from there
 * rather than re-derived, because re-deriving would mean downloading and
 * probing a multi-GB video a second time. A video is never downloaded here.
 *
 * If no GPS is present it returns { success: true, metadata: {} } — a clean
 * no-op without errors.
 *
 * A geocoder failure fails the processor for a PHOTO (unchanged behaviour),
 * but only logs for a VIDEO: reverse geocoding is enrichment, the same reason
 * video-probe is optional, and a provider hiccup must not mark a video whose
 * thumbnail succeeded as failed. The coordinates are already on the item, so
 * the `geocode` enrichment job (admin geocode backfill) heals it later.
 *
 * Writes:
 *   { country, countryCode, admin1, admin2, locality, placeName, source, geocodedAt }
 */
@Injectable()
export class ReverseGeocodeProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ReverseGeocodeProcessor.name);

  readonly name = 'geocode';
  readonly priority = 30;

  constructor(private readonly geoLocationService: GeoLocationService) {}

  canProcess(object: StorageObject): boolean {
    return object.mimeType.startsWith('image/') || object.mimeType.startsWith('video/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
    priorResults?: Readonly<Record<string, unknown>>,
  ): Promise<ObjectProcessorResult> {
    if (object.mimeType.startsWith('video/')) {
      return this.processVideo(object, priorResults);
    }

    try {
      // Step 1: Re-extract GPS from the stream independently
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);

      const exifr = await getExifr();
      const gps = await exifr.parse(buffer, {
        // Only parse GPS block to minimize overhead
        gps: true,
        tiff: false,
        exif: false,
        translateValues: false,
        reviveValues: true,
        sanitize: true,
      }).catch(() => undefined);

      const lat = gps?.['latitude'] ?? gps?.['GPSLatitude'];
      const lng = gps?.['longitude'] ?? gps?.['GPSLongitude'];

      // Guard with Number.isFinite (not typeof): `typeof NaN === 'number'` is true,
      // so a computed NaN latitude/longitude (e.g. exifr's result for an empty GPS
      // block written by phones with location off) would otherwise slip through and
      // be handed to the offline geocoder, which returns a bogus nearest city.
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        // No usable GPS present — clean no-op
        this.logger.debug(`No GPS data for object ${object.id}; skipping geocode`);
        return { success: true, metadata: {} };
      }

      // Step 2: Call geo location service (dynamic provider selection).
      // Number.isFinite does not narrow `unknown`, but it guarantees a real
      // finite number at runtime, so the cast is safe.
      const { result, source } = await this.geoLocationService.reverseGeocode(
        lat as number,
        lng as number,
      );

      return {
        success: true,
        metadata: this.toMetadata(object, lat as number, lng as number, result, source),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`geocode failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Videos: geocode the coordinates video-probe already read from the
   * container. Never downloads the video, and never fails the object.
   */
  private async processVideo(
    object: StorageObject,
    priorResults: Readonly<Record<string, unknown>> | undefined,
  ): Promise<ObjectProcessorResult> {
    const probe = priorResults?.['video-probe'] as Record<string, unknown> | undefined;
    const lat = probe?.['latitude'];
    const lng = probe?.['longitude'];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`No container GPS for video ${object.id}; skipping geocode`);
      return { success: true, metadata: {} };
    }

    try {
      const { result, source } = await this.geoLocationService.reverseGeocode(
        lat as number,
        lng as number,
      );
      return {
        success: true,
        metadata: this.toMetadata(object, lat as number, lng as number, result, source),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `geocode failed for video ${object.id} (left ungeocoded, object not failed): ${message}`,
      );
      return { success: true, metadata: {} };
    }
  }

  private toMetadata(
    object: StorageObject,
    lat: number,
    lng: number,
    result: GeoLocationResult | null,
    source: string,
  ): Record<string, unknown> {
    if (!result) {
      this.logger.debug(`Geo provider returned null for object ${object.id} (${lat}, ${lng})`);
      return {};
    }

    const metadata: Record<string, unknown> = {
      source,
      geocodedAt: new Date().toISOString(),
    };

    if (result.country !== undefined) metadata['country'] = result.country;
    if (result.countryCode !== undefined) metadata['countryCode'] = result.countryCode;
    if (result.admin1 !== undefined) metadata['admin1'] = result.admin1;
    if (result.admin2 !== undefined) metadata['admin2'] = result.admin2;
    if (result.locality !== undefined) metadata['locality'] = result.locality;
    if (result.placeName !== undefined) metadata['placeName'] = result.placeName;

    this.logger.debug(
      `Geocoded object ${object.id}: ${result.country} / ${result.admin1} / ${result.locality}`,
    );

    return metadata;
  }
}
