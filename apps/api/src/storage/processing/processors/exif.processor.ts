import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { extractExif } from '@memoriahub/enrichment-compute/metadata';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

/**
 * ExifProcessor — extracts EXIF metadata from image files.
 *
 * Name:     exif
 * Priority: 20
 * Handles:  image/* MIME types only
 *
 * The field extraction itself (exifr parse + capturedAt/GPS/camera/orientation/
 * burstUuid mapping) lives in the shared parity package
 * @memoriahub/enrichment-compute/metadata (`extractExif`) so distributed worker
 * nodes extract EXACTLY the same values as the server. This class keeps only
 * the host concerns: streaming, logging, and the never-throws success/failure
 * envelope.
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

      const metadata = await extractExif(buffer);

      this.logger.debug(`EXIF extracted for object ${object.id}: ${JSON.stringify(Object.keys(metadata))}`);

      return { success: true, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`exif failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
