// =============================================================================
// VideoFaceDetectionHandler  (type = 'video_face_detection')
// =============================================================================
//
// Enrichment handler for extracting faces from video media items.
//
// Pipeline:
//   1. Guard: require mediaItemId; load MediaItem + StorageObject.
//   2. Read face.video settings; if enabled===false, mark no_faces and return.
//   3. Resolve provider/creds via FaceDetectionCore.
//   4. Download video → temp file (constant memory) → extract frames via
//      VideoFrameExtractionService; temp file is cleaned up afterward.
//   5. For each frame: prepareImageForProcessing → core.detectWithThrottleMapping.
//   6. Cross-frame dedup: greedy clustering by cosine similarity ≥ clusterThreshold.
//      Providers without embeddings (e.g. Rekognition) skip dedup and use every
//      detection as its own representative.
//   7. For each cluster representative: upload frame JPEG to storage under
//      key `video-faces/{mediaItemId}/{uuid}.jpg`; set frameThumbnailKey.
//   8. Delete existing non-manual Face rows (idempotency).
//   9. core.persistAndMatchFaces (passes video fields).
//  10. Upsert MediaFaceStatus.
//
// On any error: markFailed and rethrow so the enrichment worker retries.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { promises as fs } from 'fs';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceDetectionCore, NormalizedFace, VideoFaceFields } from './face-detection-core.service';
import { VideoFrameExtractionService } from './video-frame-extraction.service';
import { FaceMatchingService } from './face-matching.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { streamToTempFile, assertDiskSpaceForDownload } from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { MediaFaceStatusType } from '@prisma/client';
import { DetectedFace, FaceProvider, FaceProviderCredentials } from './providers/face-provider.interface';

// Max long-edge for face detection on video frames (same env var as photo path)
const FACE_MAX_IMAGE_DIM = (): number =>
  parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10);

// Optional hard cap (bytes) on the size of videos processed by video
// enrichment; 0 (default) disables the cap. Shared env var with
// social-media detection so operators set one knob for both.
const VIDEO_ENRICHMENT_MAX_BYTES = (): number =>
  parseInt(process.env.VIDEO_ENRICHMENT_MAX_BYTES ?? '0', 10);

// Max long-edge for frame thumbnail upload (fixed at 800 px like thumbnail processor)
const FRAME_THUMB_MAX_DIM = 800;

// Max long-edge for face-crop thumbnail (face-centered crop target)
const FACE_CROP_MAX_DIM = 512;

/** A detection result tagged with its source frame timestamp. */
interface FrameDetection {
  face: DetectedFace;
  /** Normalized face (after prepareImageForProcessing). */
  normalizedFace: NormalizedFace;
  timestampMs: number;
  /** The frame JPEG buffer (already prepared/downscaled). */
  frameBuf: Buffer;
}

/** A cluster of detections representing the same identity across frames. */
interface FaceCluster {
  representative: FrameDetection;
  allTimestampsMs: number[];
}

@Injectable()
export class VideoFaceDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'video_face_detection';

  private readonly logger = new Logger(VideoFaceDetectionHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly core: FaceDetectionCore,
    private readonly frameExtractor: VideoFrameExtractionService,
    private readonly matchingService: FaceMatchingService,
    private readonly resolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('video_face_detection job missing mediaItemId');
    }

    // --- 1. Set status → processing ---
    await this.core.markProcessing(job.mediaItemId);

    // --- 2. Resolve provider + creds ---
    let providerKey: string;
    let modelVersion: string;
    let provider: FaceProvider;
    let creds: FaceProviderCredentials;

    try {
      const resolved = await this.core.resolveProviderAndCreds();
      providerKey = resolved.providerKey;
      modelVersion = resolved.modelVersion;
      provider = resolved.provider;
      creds = resolved.creds;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`VideoFaceJob ${job.id}: ${errMsg}`);
      await this.core.markFailed(job.mediaItemId, null, 'unknown', errMsg);
      throw err;
    }

    await this.enrichmentJobService.recordModel(job.id, providerKey, modelVersion);

    try {
      // --- 3. Load MediaItem ---
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          circleId: true,
          type: true,
          durationMs: true,
          width: true,
          height: true,
          socialMediaSource: true,
          storageObject: {
            select: {
              storageKey: true,
              storageProvider: true,
              bucket: true,
              name: true,
              size: true,
            },
          },
        },
      });

      if (!mediaItem || !mediaItem.storageObject) {
        const errMsg = `MediaItem ${job.mediaItemId} or its StorageObject not found`;
        this.logger.error(`VideoFaceJob ${job.id}: ${errMsg}`);
        await this.core.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
        throw new Error(errMsg);
      }

      // --- 3b. Skip social-media re-uploads ---
      // Videos flagged as social-media re-uploads (TikTok/Instagram/Facebook)
      // are not personal footage; skip face detection entirely without even
      // downloading the video. Mark no_faces so the item reads as processed.
      if (mediaItem.socialMediaSource) {
        this.logger.log(
          `VideoFaceJob ${job.id}: skipping video face detection — flagged social media (${mediaItem.socialMediaSource})`,
        );
        await this.core.markStatus(
          job.mediaItemId,
          MediaFaceStatusType.no_faces,
          0,
          providerKey,
          modelVersion,
        );
        return;
      }

      // --- 4. Read face.video settings ---
      const settings = await this.prisma.systemSettings.findUnique({
        where: { key: 'global' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const videoSettings = (settings?.value as any)?.face?.video as
        | { enabled?: boolean; sampleIntervalSeconds?: number; maxFramesPerVideo?: number }
        | undefined;

      const videoEnabled = videoSettings?.enabled ?? true;
      if (!videoEnabled) {
        this.logger.log(
          `VideoFaceJob ${job.id}: face.video.enabled=false; marking no_faces and skipping`,
        );
        await this.core.markStatus(
          job.mediaItemId,
          MediaFaceStatusType.no_faces,
          0,
          providerKey,
          modelVersion,
        );
        return;
      }

      const sampleIntervalSeconds = videoSettings?.sampleIntervalSeconds ?? 5;
      const maxFrames = videoSettings?.maxFramesPerVideo ?? 60;

      // --- 4b. Optional hard size cap ---
      // When VIDEO_ENRICHMENT_MAX_BYTES is set, oversized videos are skipped
      // entirely (marked no_faces, like the other skip paths above) without
      // downloading a single byte.
      const maxBytes = VIDEO_ENRICHMENT_MAX_BYTES();
      if (maxBytes > 0 && mediaItem.storageObject.size > BigInt(maxBytes)) {
        this.logger.warn(
          `VideoFaceJob ${job.id}: skipping video face detection — object size ` +
            `${mediaItem.storageObject.size} bytes exceeds VIDEO_ENRICHMENT_MAX_BYTES=${maxBytes}`,
        );
        await this.core.markStatus(
          job.mediaItemId,
          MediaFaceStatusType.no_faces,
          0,
          providerKey,
          modelVersion,
        );
        return;
      }

      // --- 5. Download video (stream directly to a temp file — constant memory) ---
      const fileExt = extname(mediaItem.storageObject.name || '') || '.mp4';
      const tmpVideoPath = join(tmpdir(), `memoriaHub-vface-dl-${randomUUID()}${fileExt}`);

      const objectProvider = await this.resolver.getProviderFor(
        mediaItem.storageObject.storageProvider,
        mediaItem.storageObject.bucket,
      );

      // Pre-flight: fail fast (through the normal retry/backoff path) when the
      // temp filesystem cannot hold the download plus headroom.
      await assertDiskSpaceForDownload(mediaItem.storageObject.size, tmpdir());

      let allDetections: FrameDetection[];
      try {
        // Download INSIDE the try so a failed/partial streamToTempFile still
        // has its partial temp file unlinked by the finally below.
        const videoStream = await objectProvider.download(mediaItem.storageObject.storageKey);
        await streamToTempFile(videoStream, tmpVideoPath);

        // --- 6. Extract frames ---
        const frames = await this.frameExtractor.extractFrames(tmpVideoPath, {
          durationMs: mediaItem.durationMs,
          sampleIntervalSeconds,
          maxFrames,
          fileExtension: fileExt,
        });

        this.logger.log(
          `VideoFaceJob ${job.id}: extracted ${frames.length} frame(s) from MediaItem ${job.mediaItemId}`,
        );

        // --- 7. Detect faces in each frame ---
        allDetections = [];

        for (const frame of frames) {
          // prepareImageForProcessing applies EXIF orientation + downscales
          const prepared = await prepareImageForProcessing(frame.buffer, {
            maxDim: FACE_MAX_IMAGE_DIM(),
          });

          const frameBuf =
            prepared.width > 0 ? prepared.buffer : frame.buffer;
          const frameWidth = prepared.width > 0 ? prepared.width : (mediaItem.width ?? 0);
          const frameHeight = prepared.height > 0 ? prepared.height : (mediaItem.height ?? 0);

          let detectedFaces: DetectedFace[];
          try {
            detectedFaces = await this.core.detectWithThrottleMapping(
              provider,
              creds,
              frameBuf,
              providerKey,
            );
          } catch (detectErr) {
            // RateLimitError must propagate (worker handles deferral)
            throw detectErr;
          }

          const logCtx = `VideoFaceJob ${job.id} frame@${frame.timestampMs}ms`;
          for (const face of detectedFaces) {
            const normalizedFace = this.core.normalizeFace(
              face,
              frameWidth,
              frameHeight,
              logCtx,
            );
            allDetections.push({
              face,
              normalizedFace,
              timestampMs: frame.timestampMs,
              frameBuf,
            });
          }
        }
      } finally {
        // The downloaded temp file is only needed for download + frame
        // extraction above; always clean it up regardless of success/failure —
        // including a partial file left behind by a failed streamToTempFile.
        await fs.unlink(tmpVideoPath).catch(() => {});
      }

      this.logger.log(
        `VideoFaceJob ${job.id}: total raw detections across all frames: ${allDetections.length}`,
      );

      // --- 8. Cross-frame dedup ---
      const clusters = clusterDetections(
        allDetections,
        this.matchingService,
        provider.capabilities.delegatedRecognize,
      );

      this.logger.log(
        `VideoFaceJob ${job.id}: ${clusters.length} unique face cluster(s) after dedup`,
      );

      // --- 9. Upload representative frame thumbnails ---
      const { id: activeProviderId, provider: activeStorageProvider } =
        await this.resolver.getActiveProvider();

      const facesWithVideoFields: Array<NormalizedFace & VideoFaceFields> = [];

      for (const cluster of clusters) {
        const rep = cluster.representative;

        // Build face-centered crop thumbnail; fall back to full-frame resize on any error
        let thumbBuffer: Buffer;
        try {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(rep.frameBuf).metadata();
          const bb = rep.normalizedFace.boundingBox;

          const frameW = meta.width ?? 0;
          const frameH = meta.height ?? 0;

          if (bb.w > 0 && bb.h > 0 && frameW > 0 && frameH > 0) {
            // 35% padding on each side of the bounding box
            const padX = bb.w * 0.35;
            const padY = bb.h * 0.35;

            const left   = Math.max(0, Math.min(1, bb.x - padX));
            const top    = Math.max(0, Math.min(1, bb.y - padY));
            const right  = Math.max(0, Math.min(1, bb.x + bb.w + padX));
            const bottom = Math.max(0, Math.min(1, bb.y + bb.h + padY));

            const cropLeft = Math.round(left   * frameW);
            const cropTop  = Math.round(top    * frameH);
            let   cropW    = Math.max(1, Math.round(right  * frameW) - cropLeft);
            let   cropH    = Math.max(1, Math.round(bottom * frameH) - cropTop);

            // Clamp so the crop never exceeds the frame boundary
            cropW = Math.min(cropW, frameW - cropLeft);
            cropH = Math.min(cropH, frameH - cropTop);

            thumbBuffer = await sharp(rep.frameBuf)
              .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
              .resize({
                width: FACE_CROP_MAX_DIM,
                height: FACE_CROP_MAX_DIM,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .jpeg({ quality: 85 })
              .toBuffer();
          } else {
            // Bounding box or frame dims unavailable — fall back to full-frame resize
            thumbBuffer = await sharp(rep.frameBuf)
              .resize({
                width: FRAME_THUMB_MAX_DIM,
                height: FRAME_THUMB_MAX_DIM,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .jpeg({ quality: 85 })
              .toBuffer();
          }
        } catch (sharpErr) {
          // Non-fatal: fall back to full-frame resize on any crop/processing error
          const msg = sharpErr instanceof Error ? sharpErr.message : String(sharpErr);
          this.logger.warn(
            `VideoFaceJob ${job.id}: face-crop thumbnail failed for cluster at ${rep.timestampMs}ms — ${msg}; falling back to full-frame resize`,
          );
          try {
            const sharp = (await import('sharp')).default;
            thumbBuffer = await sharp(rep.frameBuf)
              .resize({
                width: FRAME_THUMB_MAX_DIM,
                height: FRAME_THUMB_MAX_DIM,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .jpeg({ quality: 85 })
              .toBuffer();
          } catch {
            // Last-resort: store raw frame buffer without any processing
            thumbBuffer = rep.frameBuf;
          }
        }

        // Upload to active storage provider
        const frameThumbId = randomUUID();
        const frameThumbnailKey = `video-faces/${job.mediaItemId}/${frameThumbId}.jpg`;

        try {
          const thumbStream = Readable.from(thumbBuffer);
          await activeStorageProvider.upload(frameThumbnailKey, thumbStream, {
            mimeType: 'image/jpeg',
            contentLength: thumbBuffer.length,
          });
        } catch (uploadErr) {
          // Non-fatal: proceed without thumbnail key
          const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          this.logger.warn(
            `VideoFaceJob ${job.id}: frame thumbnail upload failed for cluster at ${rep.timestampMs}ms — ${msg}`,
          );
          facesWithVideoFields.push({
            ...rep.normalizedFace,
            videoTimestampMs: rep.timestampMs,
            videoTimestamps: [...cluster.allTimestampsMs].sort((a, b) => a - b),
            // frameThumbnailKey omitted — upload failed
          });
          continue;
        }

        // Register a StorageObject row so MediaThumbnailService.signThumb()
        // can look up the provider/bucket and produce a signed URL.
        // status='ready' keeps it out of the processing pipeline.
        // Upsert (keyed on storageKey) makes re-detection idempotent.
        await this.prisma.storageObject.upsert({
          where: { storageKey: frameThumbnailKey },
          update: {
            size: BigInt(thumbBuffer.length),
            mimeType: 'image/jpeg',
            storageProvider: activeProviderId,
            bucket: activeStorageProvider.getBucket(),
            status: 'ready',
            metadata: { videoFaceFrameOf: job.mediaItemId },
            updatedAt: new Date(),
          },
          create: {
            name: `video-face-${frameThumbId}.jpg`,
            size: BigInt(thumbBuffer.length),
            mimeType: 'image/jpeg',
            storageKey: frameThumbnailKey,
            storageProvider: activeProviderId,
            bucket: activeStorageProvider.getBucket(),
            status: 'ready',
            uploadedById: null,
            metadata: { videoFaceFrameOf: job.mediaItemId },
          },
        });

        facesWithVideoFields.push({
          ...rep.normalizedFace,
          videoTimestampMs: rep.timestampMs,
          videoTimestamps: [...cluster.allTimestampsMs].sort((a, b) => a - b),
          frameThumbnailKey,
        });
      }

      // --- 10. Delete existing non-manual Face rows (idempotency) ---
      await this.prisma.face.deleteMany({
        where: {
          mediaItemId: job.mediaItemId,
          manuallyAssigned: false,
        },
      });
      // TODO: Best-effort deletion of previously-written video-faces/{mediaItemId}/* thumbnails
      // from storage is non-trivial (would require listing storage objects by prefix).
      // Left as a future improvement — stale thumbnails in storage do not affect correctness.

      // --- 11. Persist Face rows + match to Persons ---
      const faceCount = await this.core.persistAndMatchFaces({
        mediaItemId: job.mediaItemId,
        circleId: mediaItem.circleId,
        providerKey,
        modelVersion,
        faces: facesWithVideoFields,
        isVideo: true,
      });

      // --- 12. Upsert MediaFaceStatus ---
      const finalStatus =
        faceCount > 0
          ? MediaFaceStatusType.processed
          : MediaFaceStatusType.no_faces;

      await this.core.markStatus(
        job.mediaItemId,
        finalStatus,
        faceCount,
        providerKey,
        modelVersion,
      );

      this.logger.log(
        `VideoFaceJob ${job.id}: completed — ${faceCount} unique face(s) in MediaItem ${job.mediaItemId} using ${providerKey}/${modelVersion}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.core.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-frame dedup: greedy single-pass clustering
// ---------------------------------------------------------------------------

/**
 * Group raw frame detections into identity clusters using greedy single-pass
 * cosine similarity matching.
 *
 * Algorithm:
 *   For each detection (in order):
 *     - Compare its embedding to every existing cluster's representative.
 *     - If similarity ≥ clusterThreshold, assign it to the best-matching cluster
 *       and update the representative if this detection has higher confidence
 *       (tie-break: larger bounding-box area).
 *     - Otherwise, start a new cluster.
 *
 * Providers without per-detection embeddings (e.g. Rekognition delegated):
 *   Skip clustering — every detection becomes its own cluster. The lack of
 *   embeddings makes cross-frame identity linking impossible; per-detection
 *   Face rows still record videoTimestampMs.
 *
 * @param detections  All raw face detections across all frames (order preserved).
 * @param matching    FaceMatchingService (provides cosineSimilarity + clusterThreshold).
 * @param isDelegated True when the provider uses delegated recognition (no embeddings).
 */
function clusterDetections(
  detections: FrameDetection[],
  matching: FaceMatchingService,
  isDelegated: boolean,
): FaceCluster[] {
  if (detections.length === 0) return [];

  // Delegated providers have no embeddings — skip dedup, one cluster per detection
  if (isDelegated) {
    return detections.map((d) => ({
      representative: d,
      allTimestampsMs: [d.timestampMs],
    }));
  }

  const clusters: FaceCluster[] = [];

  for (const detection of detections) {
    const emb = detection.normalizedFace.embedding;

    // Detections with no embedding cannot be clustered — treat as singleton
    if (emb.length === 0) {
      clusters.push({
        representative: detection,
        allTimestampsMs: [detection.timestampMs],
      });
      continue;
    }

    let bestClusterIdx = -1;
    let bestSim = -Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const repEmb = clusters[i].representative.normalizedFace.embedding;
      if (repEmb.length === 0) continue;

      const sim = matching.cosineSimilarity(emb, repEmb);
      if (sim > bestSim) {
        bestSim = sim;
        bestClusterIdx = i;
      }
    }

    if (bestClusterIdx >= 0 && bestSim >= matching.clusterThreshold) {
      // Assign to existing cluster
      const cluster = clusters[bestClusterIdx];
      cluster.allTimestampsMs.push(detection.timestampMs);

      // Update representative if this detection is better:
      //   Higher confidence wins; tie-break = larger bbox area.
      if (isBetterRepresentative(detection, cluster.representative)) {
        cluster.representative = detection;
      }
    } else {
      // Start a new cluster
      clusters.push({
        representative: detection,
        allTimestampsMs: [detection.timestampMs],
      });
    }
  }

  return clusters;
}

/**
 * Returns true when `candidate` is a better cluster representative than `current`.
 * Higher confidence wins. On tie, larger bounding-box area wins.
 */
function isBetterRepresentative(
  candidate: FrameDetection,
  current: FrameDetection,
): boolean {
  const candConf = candidate.face.confidence ?? 0;
  const currConf = current.face.confidence ?? 0;

  if (candConf !== currConf) return candConf > currConf;

  // Tie-break: larger bbox area
  const candBb = candidate.normalizedFace.boundingBox;
  const currBb = current.normalizedFace.boundingBox;
  return candBb.w * candBb.h > currBb.w * currBb.h;
}

