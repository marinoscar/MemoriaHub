import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { streamToBuffer } from './stream-utils';
import { computeVisualHash } from '../visual-hash.util';

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

      const result = await computeVisualHash(buffer);

      if (!result) {
        this.logger.warn(
          `computeVisualHash returned null for object ${object.id}; skipping visual-hash`,
        );
        return { success: true, metadata: {} };
      }

      const { perceptualHash, sharpnessScore } = result;

      this.logger.debug(
        `visual-hash for object ${object.id}: dHash=${perceptualHash.toString().slice(0, 8)}… sharpness=${sharpnessScore.toFixed(2)}`,
      );

      return {
        success: true,
        metadata: {
          perceptualHash: perceptualHash.toString(), // BigInt not JSON-serializable; store as string
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
