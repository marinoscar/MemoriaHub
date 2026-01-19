import exifr from 'exifr';
import type { ExtractedMetadata, ExifData } from '@memoriahub/shared';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * EXIF extraction service
 * Extracts metadata from images and videos using the exifr library
 */
export class ExifService {
  /**
   * Extract metadata from a media file buffer
   * @param buffer File buffer
   * @param mimeType MIME type of the file
   * @returns Extracted metadata
   */
  async extractMetadata(buffer: Buffer, mimeType: string): Promise<ExtractedMetadata> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      // Extract raw EXIF data with comprehensive options
      const rawExif: Record<string, unknown> | null = await exifr.parse(buffer, {
        // Parse all segments
        tiff: true,
        exif: true,
        gps: true,
        iptc: true,
        xmp: true,
        icc: true,
        // Translate values to human-readable format
        translateKeys: true,
        translateValues: true,
        // Revive dates as Date objects
        reviveValues: true,
      }) as Record<string, unknown> | null;

      if (!rawExif) {
        logger.debug({
          eventType: 'exif.extract.no_data',
          mimeType,
          durationMs: Date.now() - startTime,
          traceId,
        }, 'No EXIF data found in file');

        return this.emptyMetadata();
      }

      // Extract specific fields into structured format
      const metadata = this.parseExifData(rawExif);

      logger.debug({
        eventType: 'exif.extract.success',
        mimeType,
        hasCameraInfo: !!metadata.cameraMake || !!metadata.cameraModel,
        hasGps: !!metadata.latitude && !!metadata.longitude,
        hasDateTime: !!metadata.capturedAtUtc,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'EXIF metadata extracted');

      return metadata;
    } catch (error) {
      logger.warn({
        eventType: 'exif.extract.error',
        mimeType,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Failed to extract EXIF metadata');

      // Return empty metadata on error (don't fail the upload)
      return this.emptyMetadata();
    }
  }

  /**
   * Extract just GPS coordinates (faster for geocoding checks)
   * @param buffer File buffer
   * @returns GPS coordinates or null
   */
  async extractGps(buffer: Buffer): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const gps = await exifr.gps(buffer);
      if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
        return { latitude: gps.latitude, longitude: gps.longitude };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract just the orientation (for image rotation)
   * @param buffer File buffer
   * @returns Orientation value (1-8) or null
   */
  async extractOrientation(buffer: Buffer): Promise<number | null> {
    try {
      const orientation = await exifr.orientation(buffer);
      return typeof orientation === 'number' ? orientation : null;
    } catch {
      return null;
    }
  }

  /**
   * Parse raw EXIF data into structured metadata
   */
  private parseExifData(raw: Record<string, unknown>): ExtractedMetadata {
    // Extract camera information
    const cameraMake = this.getString(raw, ['Make', 'make']) ?? null;
    const cameraModel = this.getString(raw, ['Model', 'model']) ?? null;

    // Extract GPS coordinates
    const latitude = this.getNumber(raw, ['latitude', 'GPSLatitude']) ?? null;
    const longitude = this.getNumber(raw, ['longitude', 'GPSLongitude']) ?? null;

    // Extract capture time
    const capturedAtUtc = this.getDate(raw, [
      'DateTimeOriginal',
      'CreateDate',
      'ModifyDate',
      'DateCreated',
    ]);

    // Extract timezone offset
    const timezoneOffset = this.parseTimezoneOffset(raw);

    // Extract dimensions
    const width = this.getNumber(raw, ['ImageWidth', 'ExifImageWidth', 'PixelXDimension']);
    const height = this.getNumber(raw, ['ImageHeight', 'ExifImageHeight', 'PixelYDimension']);

    // Extract orientation
    const orientation = this.getNumber(raw, ['Orientation']);

    // Build full EXIF data object
    const exifData = this.buildExifData(raw);

    return {
      cameraMake,
      cameraModel,
      latitude,
      longitude,
      capturedAtUtc,
      timezoneOffset,
      width: width !== undefined ? Math.round(width) : null,
      height: height !== undefined ? Math.round(height) : null,
      orientation: orientation !== undefined ? Math.round(orientation) : null,
      durationSeconds: null, // Video duration handled separately
      exifData,
    };
  }

  /**
   * Build structured EXIF data from raw values
   */
  private buildExifData(raw: Record<string, unknown>): ExifData {
    return {
      // Camera info
      make: this.getString(raw, ['Make', 'make']),
      model: this.getString(raw, ['Model', 'model']),
      software: this.getString(raw, ['Software', 'software']),
      lensModel: this.getString(raw, ['LensModel', 'LensInfo']),

      // Capture time
      dateTimeOriginal: this.getDateString(raw, ['DateTimeOriginal']),
      dateTimeDigitized: this.getDateString(raw, ['CreateDate', 'DateTimeDigitized']),
      offsetTimeOriginal: this.getString(raw, ['OffsetTimeOriginal', 'OffsetTime']),

      // Exposure settings
      exposureTime: this.formatExposureTime(raw),
      fNumber: this.getNumber(raw, ['FNumber', 'ApertureValue']),
      iso: this.getNumber(raw, ['ISO', 'ISOSpeedRatings']),
      exposureProgram: this.getString(raw, ['ExposureProgram']),
      exposureMode: this.getString(raw, ['ExposureMode']),
      exposureBias: this.getNumber(raw, ['ExposureCompensation', 'ExposureBiasValue']),

      // Lens settings
      focalLength: this.getNumber(raw, ['FocalLength']),
      focalLengthIn35mm: this.getNumber(raw, ['FocalLengthIn35mmFormat', 'FocalLengthIn35mmFilm']),
      aperture: this.getNumber(raw, ['ApertureValue', 'FNumber']),

      // Flash
      flash: this.getString(raw, ['Flash']),
      flashMode: this.getString(raw, ['FlashMode']),

      // Image settings
      whiteBalance: this.getString(raw, ['WhiteBalance']),
      meteringMode: this.getString(raw, ['MeteringMode']),
      colorSpace: this.getString(raw, ['ColorSpace']),
      orientation: this.getNumber(raw, ['Orientation']),

      // GPS data
      gpsLatitude: this.getNumber(raw, ['latitude', 'GPSLatitude']),
      gpsLongitude: this.getNumber(raw, ['longitude', 'GPSLongitude']),
      gpsAltitude: this.getNumber(raw, ['GPSAltitude']),
      gpsSpeed: this.getNumber(raw, ['GPSSpeed']),
      gpsDirection: this.getNumber(raw, ['GPSImgDirection', 'GPSDestBearing']),
      gpsTimestamp: this.getString(raw, ['GPSDateStamp', 'GPSTimeStamp']),
    };
  }

  /**
   * Get string value from multiple possible keys
   */
  private getString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  /**
   * Get number value from multiple possible keys
   */
  private getNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'number' && !isNaN(value)) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Get date value from multiple possible keys
   */
  private getDate(obj: Record<string, unknown>, keys: string[]): Date | null {
    for (const key of keys) {
      const value = obj[key];
      if (value instanceof Date && !isNaN(value.getTime())) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = this.parseExifDate(value);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  /**
   * Get date as ISO string from multiple possible keys
   */
  private getDateString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    const date = this.getDate(obj, keys);
    return date ? date.toISOString() : undefined;
  }

  /**
   * Parse EXIF date string (format: "YYYY:MM:DD HH:MM:SS")
   */
  private parseExifDate(dateStr: string): Date | null {
    try {
      // EXIF date format: "YYYY:MM:DD HH:MM:SS"
      const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) {
        const [, year, month, day, hour, minute, second] = match;
        return new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          parseInt(hour),
          parseInt(minute),
          parseInt(second)
        );
      }
      // Try standard ISO format
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse timezone offset from EXIF data
   * Returns offset in minutes from UTC
   */
  private parseTimezoneOffset(obj: Record<string, unknown>): number | null {
    const offsetStr = this.getString(obj, ['OffsetTimeOriginal', 'OffsetTime', 'OffsetTimeDigitized']);
    if (!offsetStr) return null;

    // Format: "+HH:MM" or "-HH:MM"
    const match = offsetStr.match(/^([+-])(\d{2}):(\d{2})$/);
    if (match) {
      const [, sign, hours, minutes] = match;
      const totalMinutes = parseInt(hours) * 60 + parseInt(minutes);
      return sign === '-' ? -totalMinutes : totalMinutes;
    }
    return null;
  }

  /**
   * Format exposure time for display
   */
  private formatExposureTime(obj: Record<string, unknown>): string | undefined {
    const value = this.getNumber(obj, ['ExposureTime', 'ShutterSpeedValue']);
    if (value === undefined) return undefined;

    if (value >= 1) {
      return `${value}s`;
    }
    // Convert to fraction
    const denominator = Math.round(1 / value);
    return `1/${denominator}s`;
  }

  /**
   * Return empty metadata structure
   */
  private emptyMetadata(): ExtractedMetadata {
    return {
      cameraMake: null,
      cameraModel: null,
      latitude: null,
      longitude: null,
      capturedAtUtc: null,
      timezoneOffset: null,
      width: null,
      height: null,
      orientation: null,
      durationSeconds: null,
      exifData: {},
    };
  }
}

// Export singleton instance
export const exifService = new ExifService();
