import { Injectable, Logger, Inject } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage-provider.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { streamToBuffer } from './stream-utils';

/**
 * ThumbnailProcessor — generates a JPEG thumbnail (≤400 px on each side) for
 * every image StorageObject.
 *
 * Name:     thumbnail
 * Priority: 40  (after exif/20, dimensions/25, geocode/30)
 * Handles:  image/* MIME types only
 *
 * Recursion guard:
 *   Returns false from canProcess() if object.storageKey starts with
 *   'thumbnails/', so the newly-created thumbnail StorageObject row (which is
 *   created directly via Prisma — NOT via OBJECT_UPLOADED_EVENT) never enters
 *   the pipeline.  Thumbnail objects are also given status 'ready' at creation
 *   time, so they would never be queued for processing even if the guard were
 *   absent.
 *
 * Writes (into returned metadata, stored in StorageObject._processing.thumbnail):
 *   { thumbnailObjectId: string, thumbnailStorageKey: string }
 *
 * On any sharp error, returns { success: false, error } — never throws.
 */
@Injectable()
export class ThumbnailProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ThumbnailProcessor.name);

  readonly name = 'thumbnail';
  readonly priority = 40;

  constructor(
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly prisma: PrismaService,
  ) {}

  canProcess(object: StorageObject): boolean {
    // Only image/* MIME types
    if (!object.mimeType.startsWith('image/')) {
      return false;
    }
    // Recursion guard: thumbnail objects live under 'thumbnails/' prefix
    if (object.storageKey.startsWith('thumbnails/')) {
      return false;
    }
    return true;
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      // 1. Buffer the stream
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);

      // 2. Generate thumbnail with sharp
      //    .rotate() auto-applies EXIF orientation before resize
      const sharp = (await import('sharp')).default;
      const thumbBuffer = await sharp(buffer)
        .rotate()
        .resize({
          width: 400,
          height: 400,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      // 3. Build the thumbnail storage key
      const thumbKey = `thumbnails/${object.id}.jpg`;

      // 4. Upload thumbnail to storage
      const thumbStream = Readable.from(thumbBuffer);
      await this.storageProvider.upload(thumbKey, thumbStream, {
        mimeType: 'image/jpeg',
        contentLength: thumbBuffer.length,
      });

      // 5. Create a StorageObject row for the thumbnail.
      //    We create directly via Prisma (NOT emitting OBJECT_UPLOADED_EVENT)
      //    so the processing pipeline never recurses.  Status is set to 'ready'
      //    immediately — no further processing needed for a thumbnail.
      const thumbObject = await this.prisma.storageObject.create({
        data: {
          name: `thumb-${object.name}`,
          size: BigInt(thumbBuffer.length),
          mimeType: 'image/jpeg',
          storageKey: thumbKey,
          storageProvider: 's3',
          bucket: this.storageProvider.getBucket(),
          status: 'ready',
          uploadedById: object.uploadedById ?? null,
          metadata: { thumbnailOf: object.id },
        },
      });

      this.logger.log(
        `Thumbnail created for StorageObject ${object.id}: ` +
          `thumb id=${thumbObject.id}, key=${thumbKey}, size=${thumbBuffer.length}B`,
      );

      return {
        success: true,
        metadata: {
          thumbnailObjectId: thumbObject.id,
          thumbnailStorageKey: thumbKey,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`thumbnail failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }
}
