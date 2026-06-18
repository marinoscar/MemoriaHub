import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';
import { getOrientedDimensions } from '../image-orientation.util';

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

      const dims = await getOrientedDimensions(buffer);

      if (!dims) {
        this.logger.warn(`Could not determine dimensions for object ${object.id}`);
        return { success: true, metadata: {} };
      }

      const { width, height } = dims;
      this.logger.debug(`Dimensions for object ${object.id}: ${width}x${height} (orientation-corrected)`);

      return { success: true, metadata: { width, height } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`dimensions failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
