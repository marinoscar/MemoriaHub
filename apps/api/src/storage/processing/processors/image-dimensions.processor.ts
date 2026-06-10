import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';

/**
 * ImageDimensionsProcessor — extracts pixel width and height from image files.
 *
 * Name:     dimensions
 * Priority: 25
 * Handles:  image/* MIME types only
 *
 * Uses sharp so that it can handle JPEG, PNG, WebP, AVIF, TIFF, GIF, HEIC,
 * etc. without requiring external binaries.
 *
 * Writes: { width: number, height: number }
 */
@Injectable()
export class ImageDimensionsProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ImageDimensionsProcessor.name);

  readonly name = 'dimensions';
  readonly priority = 25;

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

      const sharp = (await import('sharp')).default;
      const meta = await sharp(buffer).metadata();

      const width = meta.width;
      const height = meta.height;

      if (width === undefined || height === undefined) {
        this.logger.warn(`sharp could not determine dimensions for object ${object.id}`);
        return { success: true, metadata: {} };
      }

      this.logger.debug(`Dimensions for object ${object.id}: ${width}x${height}`);

      return { success: true, metadata: { width, height } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`dimensions failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
