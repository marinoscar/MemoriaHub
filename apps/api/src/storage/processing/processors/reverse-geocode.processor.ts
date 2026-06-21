import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { GeoLocationService } from '../../../media/geo/geo-location.service';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExifrModule = { parse: (src: Buffer, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> };

async function getExifr(): Promise<ExifrModule> {
  const mod = await import('exifr');
  return (mod.default ?? mod) as unknown as ExifrModule;
}

/**
 * ReverseGeocodeProcessor — reverse-geocodes GPS coordinates found in image EXIF.
 *
 * Name:     geocode
 * Priority: 30  (after exif at 20, but SELF-CONTAINED per Constraint A)
 * Handles:  image/* MIME types only
 *
 * This processor does NOT read ExifProcessor output.  It independently
 * re-extracts GPS tags from the image buffer using exifr (GPS-only parse).
 * If no GPS is present it returns { success: true, metadata: {} } — a clean
 * no-op without errors.
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
    return object.mimeType.startsWith('image/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
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

      if (typeof lat !== 'number' || typeof lng !== 'number') {
        // No GPS present — clean no-op
        this.logger.debug(`No GPS data for object ${object.id}; skipping geocode`);
        return { success: true, metadata: {} };
      }

      // Step 2: Call geo location service (dynamic provider selection)
      const { result, source } = await this.geoLocationService.reverseGeocode(lat, lng);

      if (!result) {
        this.logger.debug(`Geo provider returned null for object ${object.id} (${lat}, ${lng})`);
        return { success: true, metadata: {} };
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

      return { success: true, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`geocode failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
