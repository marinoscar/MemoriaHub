import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';

/**
 * ContentHashProcessor — computes a SHA-256 hex digest of the raw byte stream.
 *
 * Name:     content-hash
 * Priority: 10 (runs first, before EXIF / dimensions)
 * Handles:  all MIME types
 *
 * Writes: { sha256: "<hex>" }
 */
@Injectable()
export class ContentHashProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ContentHashProcessor.name);

  readonly name = 'content-hash';
  readonly priority = 10;

  canProcess(_object: StorageObject): boolean {
    return true;
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      const stream = await getStream();
      const hash = createHash('sha256');

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      const sha256 = hash.digest('hex');

      this.logger.debug(`SHA-256 for object ${object.id}: ${sha256.slice(0, 12)}…`);

      return { success: true, metadata: { sha256 } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`content-hash failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
