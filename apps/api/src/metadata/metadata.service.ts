import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EnrichmentJob, MediaMetadataStatusType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import {
  extractExif,
  extractDimensions,
  probeVideo,
  extractContainerMetadata,
  FfprobeDataLike,
} from '@memoriahub/enrichment-compute/metadata';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/providers/storage-provider.interface';
import { streamToBuffer, streamToTempFile } from '../storage/processing/processors/stream-utils';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { GeoLocationService } from '../media/geo/geo-location.service';

// =============================================================================
// COMPUTE / PERSIST split (distributed-nodes spec §6)
// =============================================================================
//
// `computeMetadata` is the PURE half — EXIF + oriented dimensions for images,
// ffprobe container metadata for videos — exactly what a distributed worker
// node runs against downloaded bytes via the shared
// @memoriahub/enrichment-compute/metadata package. Its result matches the
// `metadataExtractionResultSchema` node DTO: `{ exif, probe }`, where the
// image-side `dimensions` output (width/height) is FOLDED INTO the `exif`
// record (extractExif never emits width/height, so the fold is lossless and
// `persistMetadata` can split it back out deterministically).
//
// `persistMetadata` is the SERVER-ONLY half: it additionally runs REVERSE
// GEOCODING (which requires the server's configured geo provider credentials —
// node results NEVER include geocode data), merges everything into
// `StorageObject.metadata._processing` using the same per-processor entry
// shapes the upload pipeline writes (`exif`, `dimensions`, `video-probe`,
// `geocode`, plus `<name>_error` on failure), syncs typed MediaItem columns
// via MediaMetadataSyncService, and upserts media_metadata_status.
//
// The in-process path (`processMediaItem`) is now download → computeMetadata →
// persistMetadata, with identical guards, status transitions, and error paths
// to the previous processor-loop implementation.
// =============================================================================

/**
 * Result of the pure compute half.
 *
 * `exif` — EXIF fields (capturedAt, GPS, camera, orientation, burstUuid) plus
 *          folded-in `width`/`height` from oriented-dimension extraction.
 *          Empty object for videos (EXIF extraction is image-only, mirroring
 *          ExifProcessor.canProcess).
 * `probe` — normalized video-probe entry (durationMs, width, height, codec,
 *           capturedAt, formatName, formatTags, streamTags); null for photos.
 * `errors` — per-part compute errors keyed by processor name ('exif',
 *            'dimensions', 'video-probe'); persisted as `<name>_error` entries
 *            exactly like the legacy processor loop did. Absent on node
 *            results (a node-side compute error routes to the /failure path
 *            instead).
 */
export interface MetadataComputeResult {
  exif: Record<string, unknown>;
  probe: Record<string, unknown> | null;
  errors?: Record<string, string>;
}

@Injectable()
export class MetadataExtractionService {
  private readonly logger = new Logger(MetadataExtractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
    private readonly geoLocationService: GeoLocationService,
  ) {}

  // ---------------------------------------------------------------------------
  // COMPUTE half — pure, no Prisma. This is exactly what a worker node runs
  // (apps/cli/src/node/compute/metadata.ts mirrors this via the same shared
  // package functions).
  // ---------------------------------------------------------------------------

  /**
   * Compute metadata for one media object's bytes.
   *
   * Images (`mimeType` starts with `image/`): EXIF via `extractExif(buffer)` +
   * oriented dimensions via `extractDimensions(buffer)`, dimensions folded into
   * the `exif` record as `width`/`height`.
   *
   * Videos (`mimeType` starts with `video/`): ffprobe via `probeVideo` — this
   * REQUIRES `opts.filePath` (ffprobe seeks; callers must have materialized the
   * bytes to disk). The `buffer` argument may be empty for videos.
   *
   * Per-part failures are captured in `errors` rather than thrown, mirroring
   * the legacy processor loop's never-throws success/failure envelope.
   */
  async computeMetadata(
    buffer: Buffer,
    opts: { mimeType: string; filePath?: string },
  ): Promise<MetadataComputeResult> {
    const errors: Record<string, string> = {};
    const exif: Record<string, unknown> = {};
    let probe: Record<string, unknown> | null = null;

    if (opts.mimeType.startsWith('image/')) {
      try {
        Object.assign(exif, await extractExif(buffer));
      } catch (err) {
        errors['exif'] = err instanceof Error ? err.message : String(err);
      }

      try {
        const dims = await extractDimensions(buffer);
        if (dims) {
          exif['width'] = dims.width;
          exif['height'] = dims.height;
        }
        // dims === null mirrors ImageDimensionsProcessor's "could not determine
        // dimensions" success-with-empty-metadata path — no error recorded.
      } catch (err) {
        errors['dimensions'] = err instanceof Error ? err.message : String(err);
      }
    } else if (opts.mimeType.startsWith('video/')) {
      if (!opts.filePath) {
        errors['video-probe'] = 'video probe requires a seekable file path';
      } else {
        try {
          const timeoutMs = parseInt(process.env.FFPROBE_TIMEOUT_MS ?? '30000', 10);
          const probeData = await probeVideo(opts.filePath, { ffprobeTimeoutMs: timeoutMs });
          probe = buildProbeEntry(probeData);
        } catch (err) {
          errors['video-probe'] = err instanceof Error ? err.message : String(err);
        }
      }
    }

    return {
      exif,
      probe,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // PERSIST half — server-only. Geocoding runs HERE (provider credentials live
  // on the server; node results never carry geocode data), then the merged
  // `_processing` metadata is synced into typed MediaItem columns.
  // ---------------------------------------------------------------------------

  /**
   * Persist a compute result for the job's media item. Entry point for both
   * the in-process path (processMediaItem) and the node result-ingestion path
   * (MetadataExtractionHandler.persistNodeResult).
   *
   * Writes `_processing.exif` / `_processing.dimensions` (split back out of
   * the folded `exif` record) / `_processing['video-probe']` /
   * `_processing.geocode` (+ `<name>_error` entries) with the exact shapes the
   * upload pipeline's processors produce, then runs
   * MediaMetadataSyncService.syncFromStorageObject and marks the status row
   * `processed`. On failure marks the status row `failed` and rethrows so the
   * job routes through the normal retry path.
   */
  async persistMetadata(job: EnrichmentJob, result: MetadataComputeResult): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error(`metadata_extraction job ${job.id} is missing mediaItemId`);
    }

    const mediaItemId = job.mediaItemId;

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        storageObject: { select: { id: true, mimeType: true } },
      },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `metadata_extraction job ${job.id}: MediaItem ${mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      await this.markFailed(
        mediaItemId,
        job.circleId ?? mediaItem?.circleId ?? '',
        'MediaItem missing or deleted',
      );
      return;
    }

    const circleId = mediaItem.circleId;

    try {
      const storageObject = await this.prisma.storageObject.findUnique({
        where: { id: mediaItem.storageObject.id },
        select: { id: true, mimeType: true, metadata: true },
      });

      if (!storageObject) {
        throw new Error(`StorageObject ${mediaItem.storageObject.id} not found`);
      }

      const allMetadata = await this.buildProcessingEntries(storageObject.mimeType, result);

      // Merge into storageObject.metadata._processing, preserving existing keys
      const existingMeta = (storageObject.metadata as Record<string, unknown> | null) ?? {};
      const existingProcessing =
        (existingMeta['_processing'] as Record<string, unknown> | undefined) ?? {};

      const mergedMetadata: Record<string, unknown> = {
        ...existingMeta,
        _processing: {
          ...existingProcessing,
          ...allMetadata,
        },
        _processedAt: new Date().toISOString(),
      };

      await this.prisma.storageObject.update({
        where: { id: storageObject.id },
        data: { metadata: mergedMetadata as Prisma.InputJsonValue },
      });

      // Sync typed columns into MediaItem directly — do NOT emit OBJECT_PROCESSED_EVENT
      await this.mediaMetadataSyncService.syncFromStorageObject(storageObject.id);

      await this.prisma.mediaMetadataStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          circleId,
          status: MediaMetadataStatusType.processed,
          processedAt: new Date(),
        },
        update: {
          status: MediaMetadataStatusType.processed,
          processedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(`metadata_extraction job ${job.id}: completed for MediaItem ${mediaItemId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(mediaItemId, circleId, msg);
      throw err; // Re-throw so worker can retry
    }
  }

  /**
   * Translate a MetadataComputeResult into the per-processor `_processing`
   * entries the legacy processor loop wrote:
   *
   *   images: `exif`, `dimensions`, `geocode`  (geocode computed HERE,
   *           server-side, from the exif lat/lng — mirrors
   *           ReverseGeocodeProcessor's output shape and its success-with-{}
   *           no-GPS path)
   *   videos: `video-probe`
   *
   * Compute errors carried in `result.errors` become `<name>_error` entries;
   * an errored part's success entry is not written (matching the loop).
   */
  private async buildProcessingEntries(
    mimeType: string,
    result: MetadataComputeResult,
  ): Promise<Record<string, unknown>> {
    const allMetadata: Record<string, unknown> = {};
    const errors = result.errors ?? {};

    if (mimeType.startsWith('image/')) {
      // Split folded width/height back out into the dimensions entry.
      const { width, height, ...exifFields } = result.exif;

      if (errors['exif']) {
        allMetadata['exif_error'] = errors['exif'];
      } else {
        allMetadata['exif'] = exifFields;
      }

      if (errors['dimensions']) {
        allMetadata['dimensions_error'] = errors['dimensions'];
      } else {
        allMetadata['dimensions'] =
          typeof width === 'number' && typeof height === 'number' ? { width, height } : {};
      }

      // ------- geocode (SERVER-SIDE ONLY) -------
      // Node results never include geocode data: reverse geocoding needs the
      // server's configured provider (offline dataset / Nominatim / encrypted
      // Google credential), so it always runs in the persist half.
      const lat = exifFields['latitude'];
      const lng = exifFields['longitude'];
      try {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const { result: geo, source } = await this.geoLocationService.reverseGeocode(
            lat as number,
            lng as number,
          );
          if (geo) {
            const geocode: Record<string, unknown> = {
              source,
              geocodedAt: new Date().toISOString(),
            };
            if (geo.country !== undefined) geocode['country'] = geo.country;
            if (geo.countryCode !== undefined) geocode['countryCode'] = geo.countryCode;
            if (geo.admin1 !== undefined) geocode['admin1'] = geo.admin1;
            if (geo.admin2 !== undefined) geocode['admin2'] = geo.admin2;
            if (geo.locality !== undefined) geocode['locality'] = geo.locality;
            if (geo.placeName !== undefined) geocode['placeName'] = geo.placeName;
            allMetadata['geocode'] = geocode;
          } else {
            allMetadata['geocode'] = {};
          }
        } else {
          // No usable GPS — clean no-op entry, mirroring ReverseGeocodeProcessor.
          allMetadata['geocode'] = {};
        }
      } catch (err) {
        allMetadata['geocode_error'] = err instanceof Error ? err.message : String(err);
      }
    } else if (mimeType.startsWith('video/')) {
      if (errors['video-probe']) {
        allMetadata['video-probe_error'] = errors['video-probe'];
      } else if (result.probe) {
        allMetadata['video-probe'] = result.probe;
      }
    }

    return allMetadata;
  }

  // ---------------------------------------------------------------------------
  // In-process path: download → computeMetadata → persistMetadata
  // ---------------------------------------------------------------------------

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // Guard: mediaItemId must be present
    if (!job.mediaItemId) {
      throw new Error(`metadata_extraction job ${job.id} is missing mediaItemId`);
    }

    const mediaItemId = job.mediaItemId;

    // Load MediaItem with minimal fields + storageObject reference
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        storageObjectId: true,
        storageObject: {
          select: { id: true, storageKey: true, mimeType: true },
        },
      },
    });

    // Graceful skip: missing, deleted, or no storage object
    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `metadata_extraction job ${job.id}: MediaItem ${mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      await this.markFailed(mediaItemId, job.circleId ?? mediaItem?.circleId ?? '', 'MediaItem missing or deleted');
      return;
    }

    const circleId = mediaItem.circleId;

    // Mark as processing
    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaMetadataStatusType.processing,
      },
      update: {
        status: MediaMetadataStatusType.processing,
        lastError: null,
      },
    });

    try {
      const { storageKey, mimeType } = mediaItem.storageObject;
      const result = await this.downloadAndCompute(storageKey, mimeType);
      await this.persistMetadata(job, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(mediaItemId, circleId, msg);
      throw err; // Re-throw so worker can retry
    }
  }

  /**
   * Download the object's bytes in the shape computeMetadata needs: images are
   * buffered in memory, videos are streamed to a temp file with constant memory
   * (ffprobe requires a seekable path; buffering multi-GB videos in RAM was the
   * historical OOM source) and cleaned up afterwards.
   */
  private async downloadAndCompute(
    storageKey: string,
    mimeType: string,
  ): Promise<MetadataComputeResult> {
    if (mimeType.startsWith('video/')) {
      const tmpPath = join(tmpdir(), `memoriaHub-metadata-${randomUUID()}`);
      try {
        const stream = await this.storageProvider.download(storageKey);
        await streamToTempFile(stream, tmpPath);
        return await this.computeMetadata(Buffer.alloc(0), { mimeType, filePath: tmpPath });
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }

    const stream = await this.storageProvider.download(storageKey);
    const buffer = await streamToBuffer(stream);
    return this.computeMetadata(buffer, { mimeType });
  }

  private async markFailed(mediaItemId: string, circleId: string, error: string): Promise<void> {
    await this.prisma.mediaMetadataStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaMetadataStatusType.failed,
        lastError: error,
      },
      update: {
        status: MediaMetadataStatusType.failed,
        lastError: error,
      },
    });
  }
}

/**
 * Build the `video-probe` `_processing` entry from a raw ffprobe result —
 * mirrors VideoProbeProcessor (durationMs/width/height/codec/capturedAt/
 * formatName/formatTags/streamTags, capturedAt derived from creation_time).
 * Exported for the unit tests; the CLI node module replicates the same
 * mapping so node results match byte-for-byte.
 */
export function buildProbeEntry(probeData: FfprobeDataLike): Record<string, unknown> {
  const container = extractContainerMetadata(probeData);
  const { durationMs, width, height, codec, formatName, formatTags, streamTags } = container;

  // creation_time → capturedAt: prefer format-level tag, fall back to the
  // video stream's tag (mirrors VideoProbeProcessor).
  const videoStream = probeData.streams?.find((s) => s.codec_type === 'video');
  const rawCreationTime: unknown =
    probeData.format?.tags?.['creation_time'] ?? videoStream?.tags?.['creation_time'];

  let capturedAt: string | undefined;
  if (typeof rawCreationTime === 'string' && rawCreationTime.length > 0) {
    const d = new Date(rawCreationTime);
    if (!isNaN(d.getTime())) {
      capturedAt = d.toISOString();
    }
  }

  const metadata: Record<string, unknown> = {};
  if (durationMs !== undefined) metadata['durationMs'] = durationMs;
  if (typeof width === 'number') metadata['width'] = width;
  if (typeof height === 'number') metadata['height'] = height;
  if (typeof codec === 'string') metadata['codec'] = codec;
  if (capturedAt !== undefined) metadata['capturedAt'] = capturedAt;
  if (formatName !== undefined) metadata['formatName'] = formatName;
  metadata['formatTags'] = formatTags;
  metadata['streamTags'] = streamTags;

  return metadata;
}
