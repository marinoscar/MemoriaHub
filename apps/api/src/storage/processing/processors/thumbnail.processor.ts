import { Injectable, Logger, Inject } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { extractPosterFrame } from '@memoriahub/enrichment-compute/video';
import { ObjectProcessor, ObjectProcessorResult } from '../object-processor.interface';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage-provider.interface';
import { StorageProviderResolver } from '../../providers/storage-provider.resolver';
import { PrismaService } from '../../../prisma/prisma.service';
import { streamToBuffer, streamToTempFile } from './stream-utils';

/**
 * ThumbnailProcessor — generates a JPEG thumbnail (≤800 px on each side, by
 * default) for every image and video StorageObject.
 *
 * Name:     thumbnail
 * Priority: 40  (after exif/20, dimensions/25, video-probe/20, geocode/30)
 * Handles:  image/* and video/* MIME types
 *
 * Recursion guard:
 *   Returns false from canProcess() if object.storageKey starts with
 *   'thumbnails/', so the newly-created thumbnail StorageObject row never
 *   enters the pipeline.  Thumbnail objects are also given status 'ready' at
 *   creation time, so they would never be queued even if the guard were absent.
 *
 * Image path:
 *   Buffers the stream → sharp resize to ≤THUMBNAIL_MAX_DIM px JPEG → upload → StorageObject.
 *
 * Video path:
 *   1. Streams the download to a temp file with constant memory (buffering the
 *      whole video in RAM previously OOM'd the process on large MP4s).
 *   2. Extracts one poster frame via the shared
 *      `@memoriahub/enrichment-compute/video`'s `extractPosterFrame()`, which
 *      runs the three-attempt fallback ladder (seek 1 s → seek 0 s →
 *      `thumbnail` video filter, no seek) against fluent-ffmpeg, validating
 *      each attempt's output is non-empty (ffmpeg can exit 0 without writing
 *      a frame) and killing (SIGKILL) any attempt that exceeds
 *      FFMPEG_TIMEOUT_MS so a hung ffmpeg never wedges the pipeline. This is
 *      the same extraction code a distributed worker node's thumbnail
 *      compute module falls back to, guaranteeing identical behavior
 *      whether a video thumbnail is generated in-process or on a node.
 *   3. Runs the extracted frame through sharp (same resize/quality settings as
 *      the image path) for consistency.
 *   4. Uploads → StorageObject.  All temp files cleaned up in finally (the
 *      input temp file here; the shared extractor manages its own
 *      per-attempt output temp files internally).
 *
 * Shared upload/StorageObject-creation code is factored into
 * uploadThumbnail() to avoid duplication between the two paths.
 *
 * Env vars (read at construction time):
 *   THUMBNAIL_MAX_DIM  — max width and height in px (default: 800, fit: inside, no enlargement)
 *   THUMBNAIL_QUALITY  — JPEG quality 1–100 (default: 85)
 *   FFMPEG_TIMEOUT_MS  — max runtime per frame-extraction attempt in ms (default: 60000)
 *
 * Writes (into returned metadata, stored in StorageObject._processing.thumbnail):
 *   { thumbnailObjectId: string, thumbnailStorageKey: string }
 *
 * On any error, returns { success: false, error } — never throws.
 */
@Injectable()
export class ThumbnailProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ThumbnailProcessor.name);

  readonly name = 'thumbnail';
  readonly priority = 40;

  private readonly maxDim: number;
  private readonly quality: number;
  private readonly ffmpegTimeoutMs: number;

  constructor(
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
  ) {
    this.maxDim = parseInt(process.env.THUMBNAIL_MAX_DIM ?? '800', 10);
    this.quality = parseInt(process.env.THUMBNAIL_QUALITY ?? '85', 10);
    this.ffmpegTimeoutMs = parseInt(process.env.FFMPEG_TIMEOUT_MS ?? '60000', 10);
  }

  canProcess(object: StorageObject): boolean {
    // Recursion guard: thumbnail objects live under 'thumbnails/' prefix
    if (object.storageKey.startsWith('thumbnails/')) {
      return false;
    }
    return object.mimeType.startsWith('image/') || object.mimeType.startsWith('video/');
  }

  /**
   * Download a storage object by key.  Exposed so callers that already inject
   * ThumbnailProcessor (which holds the StorageProvider) can retrieve streams
   * without needing to inject StorageProvider themselves.
   */
  download(storageKey: string): Promise<Readable> {
    return this.storageProvider.download(storageKey);
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    if (object.mimeType.startsWith('video/')) {
      return this.processVideo(object, getStream);
    }
    return this.processImage(object, getStream);
  }

  // ---------------------------------------------------------------------------
  // Image path — unchanged from original implementation
  // ---------------------------------------------------------------------------

  private async processImage(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);

      // Intentionally rotates inline like the shared prepareImageForProcessing utility — thumbnail processor predates the util.
      const sharp = (await import('sharp')).default;
      const thumbBuffer = await sharp(buffer)
        .rotate()
        .resize({
          width: this.maxDim,
          height: this.maxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: this.quality })
        .toBuffer();

      return await this.uploadThumbnail(object, thumbBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`thumbnail(image) failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // Video path — extract poster frame via ffmpeg, then resize with sharp
  // ---------------------------------------------------------------------------

  private async processVideo(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    // Use the original file extension so ffmpeg recognises the container format;
    // fall back to .mp4 when the extension is absent or unknown.
    const origExt = extname(object.name || '') || '.mp4';
    const tmpIn = join(tmpdir(), `memoriaHub-thumb-in-${randomUUID()}${origExt}`);

    try {
      // 1. Stream the video to a temp file (ffmpeg requires a seekable path)
      const stream = await getStream();
      await streamToTempFile(stream, tmpIn);

      // 2. Extract a single poster frame via the shared package's three-attempt
      //    fallback ladder (seek 1s → seek 0s → `thumbnail` filter). It manages
      //    its own per-attempt temp output files internally.
      const frameBuffer = await extractPosterFrame(tmpIn, {
        ffmpegTimeoutMs: this.ffmpegTimeoutMs,
      });

      // 3. Run the extracted frame through sharp (consistent sizing and
      //    quality with the image path)
      const sharp = (await import('sharp')).default;
      const thumbBuffer = await sharp(frameBuffer)
        .resize({
          width: this.maxDim,
          height: this.maxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: this.quality })
        .toBuffer();

      return await this.uploadThumbnail(object, thumbBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`thumbnail(video) failed for object ${object.id}: ${message}`);
      return { success: false, error: message };
    } finally {
      // Clean up the downloaded input temp file. The output frame's temp
      // file(s) are owned and cleaned up internally by extractPosterFrame.
      await fs.unlink(tmpIn).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Shared: upload buffer + create StorageObject row
  // ---------------------------------------------------------------------------

  private async uploadThumbnail(
    object: StorageObject,
    thumbBuffer: Buffer,
  ): Promise<ObjectProcessorResult> {
    const thumbKey = `thumbnails/${object.id}.jpg`;

    // Resolve the currently active storage provider so the thumbnail lands in
    // the same provider/bucket that new uploads are routed to.
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();

    // Upload to storage
    const thumbStream = Readable.from(thumbBuffer);
    await activeProvider.upload(thumbKey, thumbStream, {
      mimeType: 'image/jpeg',
      contentLength: thumbBuffer.length,
      // Thumbnail bytes for a given storage key never change, so mark them
      // immutable and cacheable for a year — combined with the stable, long-TTL
      // signed URL from MediaThumbnailService this lets browsers reuse the
      // downloaded thumbnail instead of re-fetching it on every gallery load.
      cacheControl: 'public, max-age=31536000, immutable',
    });

    // Upsert a StorageObject row directly via Prisma (NOT emitting
    // OBJECT_UPLOADED_EVENT) so the pipeline never recurses.  status='ready'
    // means it will never be queued for processing even without the guard.
    // Using upsert (keyed on the deterministic storageKey) makes reprocessing
    // idempotent — no unique-constraint violation on repeated runs.
    const thumbObject = await this.prisma.storageObject.upsert({
      where: { storageKey: thumbKey },
      update: {
        name: `thumb-${object.name}`,
        size: BigInt(thumbBuffer.length),
        mimeType: 'image/jpeg',
        // Refresh provider/bucket too: a reprocess after the active provider
        // changed uploads the new bytes to the new provider, so the row must
        // point at it or signing would route to the old (now-empty) provider.
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'ready',
        metadata: { thumbnailOf: object.id },
        updatedAt: new Date(),
      },
      create: {
        name: `thumb-${object.name}`,
        size: BigInt(thumbBuffer.length),
        mimeType: 'image/jpeg',
        storageKey: thumbKey,
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'ready',
        uploadedById: object.uploadedById ?? null,
        metadata: { thumbnailOf: object.id },
      },
    });

    this.logger.log(
      `Thumbnail upserted for StorageObject ${object.id}: ` +
        `thumb id=${thumbObject.id}, key=${thumbKey}, size=${thumbBuffer.length}B`,
    );

    return {
      success: true,
      metadata: {
        thumbnailObjectId: thumbObject.id,
        thumbnailStorageKey: thumbKey,
      },
    };
  }
}
