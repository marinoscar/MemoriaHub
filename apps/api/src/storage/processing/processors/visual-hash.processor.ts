import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';
import { prepareImageForProcessing } from '../image-orientation.util';

/**
 * VisualHashProcessor — computes dHash and Laplacian sharpness for images.
 *
 * Name:     visual-hash
 * Priority: 45 (after thumbnail/40, before geocode/60)
 * Handles:  image/* MIME types only, skips thumbnails/
 *
 * Extracted fields:
 *   perceptualHash  — 64-bit dHash stored as string (BigInt not JSON-serializable)
 *   sharpnessScore  — variance of Laplacian (focus quality metric)
 *
 * Missing fields are omitted. This processor never throws.
 */
@Injectable()
export class VisualHashProcessor implements ObjectProcessor {
  private readonly logger = new Logger(VisualHashProcessor.name);

  readonly name = 'visual-hash';
  readonly priority = 45;

  canProcess(object: StorageObject): boolean {
    return (
      object.mimeType.startsWith('image/') &&
      !object.storageKey.startsWith('thumbnails/')
    );
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);

      // Apply EXIF orientation and downscale to 512px max dimension
      const { buffer: preparedBuffer, width } = await prepareImageForProcessing(buffer, { maxDim: 512 });

      if (width === 0) {
        this.logger.warn(`prepareImageForProcessing returned width=0 for object ${object.id}; skipping visual-hash`);
        return { success: true, metadata: {} };
      }

      const sharp = (await import('sharp')).default;

      // --- dHash: resize to 9x8 grayscale, compare adjacent pixels ---
      const { data: hashData } = await sharp(preparedBuffer)
        .resize(9, 8, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let hash = 0n;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          if (hashData[row * 9 + col] < hashData[row * 9 + col + 1]) {
            hash |= (1n << BigInt(row * 8 + col));
          }
        }
      }

      // --- Laplacian sharpness: variance of Laplacian response ---
      const { data: lapData, info: lapInfo } = await sharp(preparedBuffer)
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const n = lapInfo.width * lapInfo.height;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const v = lapData[i];
        sum += v;
        sumSq += v * v;
      }
      const mean = sum / n;
      const sharpnessScore = sumSq / n - mean * mean;

      this.logger.debug(
        `visual-hash for object ${object.id}: dHash=${hash.toString().slice(0, 8)}… sharpness=${sharpnessScore.toFixed(2)}`,
      );

      return {
        success: true,
        metadata: {
          perceptualHash: hash.toString(), // BigInt not JSON-serializable; store as string
          sharpnessScore,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`visual-hash failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
