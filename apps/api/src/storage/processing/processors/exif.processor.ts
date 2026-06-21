import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

// exifr ships ES-module and CJS builds; use dynamic import to work with ts-jest
// and tsc targeting CommonJS output.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExifrModule = { parse: (src: Buffer, opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> };

async function getExifr(): Promise<ExifrModule> {
  // Dynamic import handles both ESM and CJS environments
  const mod = await import('exifr');
  // exifr default export is the parse function itself in some builds
  return (mod.default ?? mod) as unknown as ExifrModule;
}

/**
 * ExifProcessor — extracts EXIF metadata from image files.
 *
 * Name:     exif
 * Priority: 20
 * Handles:  image/* MIME types only
 *
 * Extracted fields:
 *   capturedAt        — DateTimeOriginal as ISO 8601 UTC string
 *   capturedAtOffset  — UTC offset in minutes at capture time (from OffsetTimeOriginal)
 *   latitude          — GPS latitude (decimal)
 *   longitude         — GPS longitude (decimal)
 *   altitude          — GPS altitude in metres
 *   cameraMake        — EXIF Make
 *   cameraModel       — EXIF Model
 *   orientation       — EXIF Orientation tag (1–8)
 *
 * Missing fields are omitted from the result — they are never written as null.
 * This processor never throws; errors are returned as { success: false }.
 */
@Injectable()
export class ExifProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ExifProcessor.name);

  readonly name = 'exif';
  readonly priority = 20;

  canProcess(object: StorageObject): boolean {
    return object.mimeType.startsWith('image/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);

      const exifr = await getExifr();

      const raw = await exifr.parse(buffer, {
        tiff: true,
        exif: true,
        gps: true,
        ifd0: true,
        makerNote: true,
        mergeOutput: true,
        translateValues: false,
        reviveValues: true,
        sanitize: true,
      }).catch(() => undefined);

      if (!raw) {
        // No EXIF data present — normal for screenshots, web graphics, etc.
        return { success: true, metadata: {} };
      }

      const metadata: Record<string, unknown> = {};

      // Captured timestamp
      const dto = raw['DateTimeOriginal'];
      if (dto instanceof Date) {
        let ms = 0;
        const subSec = raw['SubSecTimeOriginal'];
        if (typeof subSec === 'string' && subSec.trim()) {
          const trimmed = subSec.trim().replace(/^\./, '');
          const frac = parseFloat('0.' + trimmed);
          if (!isNaN(frac)) ms = Math.round(frac * 1000);
        }
        const ts = new Date(dto.getTime());
        ts.setUTCMilliseconds(ms);
        metadata['capturedAt'] = ts.toISOString();
      }

      // UTC offset (stored as "+HH:MM" / "-HH:MM" or numeric minutes)
      const offsetRaw = raw['OffsetTimeOriginal'] ?? raw['OffsetTime'];
      if (typeof offsetRaw === 'string') {
        const minutes = this.parseOffsetToMinutes(offsetRaw);
        if (minutes !== null) metadata['capturedAtOffset'] = minutes;
      }

      // GPS
      const lat = raw['latitude'] ?? raw['GPSLatitude'];
      const lng = raw['longitude'] ?? raw['GPSLongitude'];
      const alt = raw['altitude'] ?? raw['GPSAltitude'];

      if (typeof lat === 'number') metadata['latitude'] = lat;
      if (typeof lng === 'number') metadata['longitude'] = lng;
      if (typeof alt === 'number') metadata['altitude'] = alt;

      // Camera info
      const make = raw['Make'];
      const model = raw['Model'];
      const orientation = raw['Orientation'];

      if (typeof make === 'string' && make.trim()) metadata['cameraMake'] = make.trim();
      if (typeof model === 'string' && model.trim()) metadata['cameraModel'] = model.trim();
      if (typeof orientation === 'number') metadata['orientation'] = orientation;

      // BurstUUID (Apple MakerNote)
      const burstUuid =
        (raw['BurstUUID'] as string | undefined) ??
        ((raw['MakerNote'] as Record<string, unknown> | undefined)?.['BurstUUID'] as string | undefined);
      if (typeof burstUuid === 'string' && burstUuid.trim()) {
        metadata['burstUuid'] = burstUuid.trim();
      }

      this.logger.debug(`EXIF extracted for object ${object.id}: ${JSON.stringify(Object.keys(metadata))}`);

      return { success: true, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`exif failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Parse an EXIF offset string like "+05:30" or "-06:00" into minutes.
   * Returns null if the value cannot be parsed.
   */
  private parseOffsetToMinutes(offset: string): number | null {
    const match = /^([+-])(\d{1,2}):(\d{2})$/.exec(offset.trim());
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3], 10);
    return sign * (hours * 60 + minutes);
  }
}
