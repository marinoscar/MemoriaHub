// =============================================================================
// VideoFaceDetectionService
// =============================================================================
//
// Compute/persist split for video_face_detection, mirroring FaceDetectionService
// (the photo path)'s processMediaItem/computeFaces/persistFaces shape exactly:
//
//   - processMediaItem: orchestrates the in-process path — all server/DB/
//     storage-credential-coupled steps (status tracking, provider/creds
//     resolution, MediaItem load, settings/skip gates, video download to a
//     temp file, and — because the server (not a node) holds storage
//     credentials — uploading the computed thumbnail bytes) — then calls
//     computeVideoFaces (compute half) and persistVideoFaces (persist half).
//
//   - computeVideoFaces: extracts frames, detects faces per frame, clusters
//     detections across frames (cross-frame dedup) via the shared
//     @memoriahub/enrichment-compute/face-video package, and builds a
//     face-centered crop thumbnail per cluster. Returns an in-memory array —
//     thumbnail bytes are still buffers, not yet uploaded (that upload step
//     needs storage credentials the server has but a node does not, so it
//     stays in processMediaItem, mirroring the same client/server asymmetry
//     thumbnail_regen's existing split already has).
//
//   - persistVideoFaces: the PERSIST half, shared by BOTH the in-process path
//     (processMediaItem, after it uploads thumbnail bytes and assembles the
//     DTO-shaped result) and the node result-ingestion path
//     (VideoFaceDetectionHandler.persistNodeResult, after zod-parsing a
//     node-submitted payload). Deletes existing non-manual Face rows,
//     normalizes each cluster via FaceDetectionCore.normalizeFace (bbox
//     pixel→0-1 conversion + embedding L2-normalization — deferred to this
//     persist half, exactly like the photo path), persists via
//     FaceDetectionCore.persistAndMatchFaces, and upserts MediaFaceStatus.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { promises as fs } from 'fs';
import type { VideoFaceDetectionResult } from '@memoriahub/enrichment-compute/dto';
import {
  clusterFaceDetections,
  buildFaceCropThumbnail,
  type ClusterableDetection,
} from '@memoriahub/enrichment-compute/face-video';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import {
  streamToTempFile,
  assertDiskSpaceForDownload,
} from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  FaceDetectionCore,
  NormalizedFace,
  ResolvedProvider,
  VideoFaceFields,
} from './face-detection-core.service';
import { VideoFrameExtractionService } from './video-frame-extraction.service';
import { FaceMatchingService } from './face-matching.service';
import type { DetectedFace } from './providers/face-provider.interface';

// Max long-edge for face detection on video frames (same env var as photo path).
const FACE_MAX_IMAGE_DIM = (): number =>
  parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10);

// Optional hard cap (bytes) on the size of videos processed by video
// enrichment; 0 (default) disables the cap. Shared env var with
// social-media detection so operators set one knob for both.
const VIDEO_ENRICHMENT_MAX_BYTES = (): number =>
  parseInt(process.env.VIDEO_ENRICHMENT_MAX_BYTES ?? '0', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal MediaItem shape computeVideoFaces needs. */
interface VideoMediaItemInput {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

interface VideoSettingsInput {
  sampleIntervalSeconds: number;
  maxFrames: number;
}

/**
 * Per-detection bookkeeping carried through clustering — opaque to the shared
 * clusterFaceDetections algorithm, which only ever reads the top-level
 * embedding/confidence/boundingBox/timestampMs fields.
 */
interface DetectionPayload {
  /** Raw (pixel-space, non-normalized) detection — used for the final DTO assembly. */
  face: DetectedFace;
  /** Prepared (post prepareImageForProcessing) dimensions for this frame. */
  frameWidth: number;
  frameHeight: number;
  /** Prepared (post prepareImageForProcessing) JPEG buffer for this frame. */
  frameBuf: Buffer;
}

/** In-memory compute result for one identity cluster — thumbnail bytes not yet uploaded. */
export interface ComputedVideoFaceCluster {
  boundingBox: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  confidence?: number;
  embedding: number[];
  landmarks?: unknown;
  videoTimestampMs: number;
  videoTimestamps: number[];
  thumbnailBuffer: Buffer;
}

@Injectable()
export class VideoFaceDetectionService {
  private readonly logger = new Logger(VideoFaceDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: FaceDetectionCore,
    private readonly frameExtractor: VideoFrameExtractionService,
    private readonly matchingService: FaceMatchingService,
    private readonly resolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // ---------------------------------------------------------------------------
  // processMediaItem — orchestrates the in-process path
  // ---------------------------------------------------------------------------

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('video_face_detection job missing mediaItemId');
    }

    // --- 1. Set status → processing ---
    await this.core.markProcessing(job.mediaItemId);

    // --- 2. Resolve provider + creds ---
    let providerKey: string;
    let modelVersion: string;
    let resolved: ResolvedProvider;

    try {
      resolved = await this.core.resolveProviderAndCreds();
      providerKey = resolved.providerKey;
      modelVersion = resolved.modelVersion;
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

      let computed: ComputedVideoFaceCluster[];
      try {
        // Download INSIDE the try so a failed/partial streamToTempFile still
        // has its partial temp file unlinked by the finally below.
        const videoStream = await objectProvider.download(mediaItem.storageObject.storageKey);
        await streamToTempFile(videoStream, tmpVideoPath);

        // --- 6-9. Compute half: extract frames, detect, cluster, crop thumbnails ---
        computed = await this.computeVideoFaces(
          tmpVideoPath,
          { durationMs: mediaItem.durationMs, width: mediaItem.width, height: mediaItem.height },
          { sampleIntervalSeconds, maxFrames },
          resolved,
          job.id,
        );
      } finally {
        // The downloaded temp file is only needed for download + frame
        // extraction above; always clean it up regardless of success/failure —
        // including a partial file left behind by a failed streamToTempFile.
        await fs.unlink(tmpVideoPath).catch(() => {});
      }

      // --- 10. Upload representative frame thumbnails (server holds storage creds) ---
      const { id: activeProviderId, provider: activeStorageProvider } =
        await this.resolver.getActiveProvider();

      const clusters: VideoFaceDetectionResult['clusters'] = [];

      for (const c of computed) {
        const frameThumbId = randomUUID();
        const frameThumbnailKey = `video-faces/${job.mediaItemId}/${frameThumbId}.jpg`;

        try {
          const thumbStream = Readable.from(c.thumbnailBuffer);
          await activeStorageProvider.upload(frameThumbnailKey, thumbStream, {
            mimeType: 'image/jpeg',
            contentLength: c.thumbnailBuffer.length,
          });
        } catch (uploadErr) {
          // Non-fatal: proceed without a thumbnail key.
          const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          this.logger.warn(
            `VideoFaceJob ${job.id}: frame thumbnail upload failed for cluster at ${c.videoTimestampMs}ms — ${msg}`,
          );
          clusters.push({
            boundingBox: c.boundingBox,
            imageWidth: c.imageWidth,
            imageHeight: c.imageHeight,
            confidence: c.confidence,
            embedding: c.embedding,
            landmarks: c.landmarks,
            videoTimestampMs: c.videoTimestampMs,
            videoTimestamps: c.videoTimestamps,
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
            size: BigInt(c.thumbnailBuffer.length),
            mimeType: 'image/jpeg',
            storageProvider: activeProviderId,
            bucket: activeStorageProvider.getBucket(),
            status: 'ready',
            metadata: { videoFaceFrameOf: job.mediaItemId },
            updatedAt: new Date(),
          },
          create: {
            name: `video-face-${frameThumbId}.jpg`,
            size: BigInt(c.thumbnailBuffer.length),
            mimeType: 'image/jpeg',
            storageKey: frameThumbnailKey,
            storageProvider: activeProviderId,
            bucket: activeStorageProvider.getBucket(),
            status: 'ready',
            uploadedById: null,
            metadata: { videoFaceFrameOf: job.mediaItemId },
          },
        });

        clusters.push({
          boundingBox: c.boundingBox,
          imageWidth: c.imageWidth,
          imageHeight: c.imageHeight,
          confidence: c.confidence,
          embedding: c.embedding,
          landmarks: c.landmarks,
          videoTimestampMs: c.videoTimestampMs,
          videoTimestamps: c.videoTimestamps,
          frameThumbnailKey,
        });
      }

      const result: VideoFaceDetectionResult = {
        modelVersion,
        providerKey,
        clusters,
      };

      // --- 11-12. Persist half: delete-then-recreate Face rows, match, mark status ---
      await this.persistVideoFaces(job, result);

      this.logger.log(
        `VideoFaceJob ${job.id}: completed — ${clusters.length} unique face(s) in MediaItem ${job.mediaItemId} using ${providerKey}/${modelVersion}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.core.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // computeVideoFaces — COMPUTE half of the split.
  //
  // Extracts frames, detects faces per frame, clusters detections across
  // frames (cross-frame dedup, via the shared face-video package), and builds
  // a face-centered crop thumbnail per cluster representative. Returns an
  // in-memory array — thumbnail bytes are buffers, not yet uploaded (that step
  // needs storage credentials only the server has).
  //
  // This is the SERVER-side compute half, used for the in-process path. A
  // distributed worker node runs the equivalent compute locally (always via
  // the keyless Human provider) and submits a VideoFaceDetectionResult
  // directly (after uploading its own thumbnails via a presigned URL),
  // bypassing this method.
  // ---------------------------------------------------------------------------

  async computeVideoFaces(
    tmpVideoPath: string,
    mediaItem: VideoMediaItemInput,
    videoSettings: VideoSettingsInput,
    resolved: ResolvedProvider,
    logJobId: string,
  ): Promise<ComputedVideoFaceCluster[]> {
    const { provider, creds, providerKey } = resolved;

    const fileExt = extname(tmpVideoPath) || '.mp4';

    const frames = await this.frameExtractor.extractFrames(tmpVideoPath, {
      durationMs: mediaItem.durationMs,
      sampleIntervalSeconds: videoSettings.sampleIntervalSeconds,
      maxFrames: videoSettings.maxFrames,
      fileExtension: fileExt,
    });

    this.logger.log(
      `VideoFaceJob ${logJobId}: extracted ${frames.length} frame(s)`,
    );

    // --- Detect faces in each frame ---
    const allDetections: ClusterableDetection<DetectionPayload>[] = [];

    for (const frame of frames) {
      // prepareImageForProcessing applies EXIF orientation + downscales.
      const prepared = await prepareImageForProcessing(frame.buffer, {
        maxDim: FACE_MAX_IMAGE_DIM(),
      });

      const frameBuf = prepared.width > 0 ? prepared.buffer : frame.buffer;
      const frameWidth = prepared.width > 0 ? prepared.width : (mediaItem.width ?? 0);
      const frameHeight = prepared.height > 0 ? prepared.height : (mediaItem.height ?? 0);

      const detectedFaces = await this.core.detectWithThrottleMapping(
        provider,
        creds,
        frameBuf,
        providerKey,
      );

      const logCtx = `VideoFaceJob ${logJobId} frame@${frame.timestampMs}ms`;
      for (const face of detectedFaces) {
        const normalizedFace = this.core.normalizeFace(face, frameWidth, frameHeight, logCtx);
        allDetections.push({
          embedding: normalizedFace.embedding,
          confidence: face.confidence,
          boundingBox: normalizedFace.boundingBox,
          timestampMs: frame.timestampMs,
          payload: { face, frameWidth, frameHeight, frameBuf },
        });
      }
    }

    this.logger.log(
      `VideoFaceJob ${logJobId}: total raw detections across all frames: ${allDetections.length}`,
    );

    // --- Cross-frame dedup ---
    const clusters = clusterFaceDetections(
      allDetections,
      this.matchingService.clusterThreshold,
      provider.capabilities.delegatedRecognize,
    );

    this.logger.log(
      `VideoFaceJob ${logJobId}: ${clusters.length} unique face cluster(s) after dedup`,
    );

    // --- Build a face-crop thumbnail per cluster representative ---
    const results: ComputedVideoFaceCluster[] = [];

    for (const cluster of clusters) {
      const rep = cluster.representative;

      let thumbnailBuffer: Buffer;
      try {
        thumbnailBuffer = await buildFaceCropThumbnail(rep.payload.frameBuf, {
          boundingBox: rep.boundingBox,
        });
      } catch (err) {
        // buildFaceCropThumbnail already falls back internally to a
        // full-frame resize on any crop/metadata error; it only throws when
        // even that fallback fails. Last resort: store the raw prepared frame
        // buffer without any processing (matches the pre-split handler's
        // third fallback tier).
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `VideoFaceJob ${logJobId}: face-crop thumbnail failed for cluster at ${rep.timestampMs}ms — ${msg}; using raw frame buffer`,
        );
        thumbnailBuffer = rep.payload.frameBuf;
      }

      results.push({
        boundingBox: {
          x: rep.payload.face.boundingBox.x,
          y: rep.payload.face.boundingBox.y,
          width: rep.payload.face.boundingBox.w,
          height: rep.payload.face.boundingBox.h,
        },
        imageWidth: rep.payload.frameWidth,
        imageHeight: rep.payload.frameHeight,
        confidence: rep.payload.face.confidence,
        embedding:
          rep.payload.face.embedding && rep.payload.face.embedding.length > 0
            ? rep.payload.face.embedding
            : [],
        landmarks: rep.payload.face.landmarks,
        videoTimestampMs: rep.timestampMs,
        videoTimestamps: [...cluster.allTimestampsMs].sort((a, b) => a - b),
        thumbnailBuffer,
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // persistVideoFaces — PERSIST half of the split.
  //
  // Shared by the in-process path (processMediaItem, above) and the node
  // result-ingestion path (VideoFaceDetectionHandler.persistNodeResult). Does
  // NOT recompute or download anything — it only deletes stale Face rows,
  // normalizes (pixel→0-1 bbox + L2-normalized embedding) and writes new Face
  // rows, runs person matching, and upserts MediaFaceStatus from an
  // already-computed DTO.
  // ---------------------------------------------------------------------------

  async persistVideoFaces(job: EnrichmentJob, result: VideoFaceDetectionResult): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('video_face_detection job missing mediaItemId');
    }
    if (!job.circleId) {
      throw new Error('video_face_detection job missing circleId');
    }

    // Delete existing non-manual Face rows (idempotency) — unconditional, even
    // when zero clusters are in the result, so a rerun that now finds nothing
    // still clears stale detections.
    await this.prisma.face.deleteMany({
      where: { mediaItemId: job.mediaItemId, manuallyAssigned: false },
    });
    // TODO: Best-effort deletion of previously-written video-faces/{mediaItemId}/*
    // thumbnails from storage is non-trivial (would require listing storage
    // objects by prefix). Left as a future improvement — stale thumbnails in
    // storage do not affect correctness.

    const logCtx = `VideoFaceJob ${job.id} MediaItem ${job.mediaItemId}`;

    const facesWithVideoFields: Array<NormalizedFace & VideoFaceFields> = result.clusters.map(
      (cluster) => {
        const asDetected: DetectedFace = {
          boundingBox: {
            x: cluster.boundingBox.x,
            y: cluster.boundingBox.y,
            w: cluster.boundingBox.width,
            h: cluster.boundingBox.height,
          },
          confidence: cluster.confidence,
          landmarks: cluster.landmarks,
          embedding: cluster.embedding,
        };
        const normalizedFace = this.core.normalizeFace(
          asDetected,
          cluster.imageWidth,
          cluster.imageHeight,
          logCtx,
        );

        return {
          ...normalizedFace,
          videoTimestampMs: cluster.videoTimestampMs,
          videoTimestamps: [...cluster.videoTimestamps].sort((a, b) => a - b),
          ...(cluster.frameThumbnailKey ? { frameThumbnailKey: cluster.frameThumbnailKey } : {}),
        };
      },
    );

    const faceCount = await this.core.persistAndMatchFaces({
      mediaItemId: job.mediaItemId,
      circleId: job.circleId,
      providerKey: result.providerKey,
      modelVersion: result.modelVersion,
      faces: facesWithVideoFields,
      isVideo: true,
    });

    const finalStatus =
      faceCount > 0 ? MediaFaceStatusType.processed : MediaFaceStatusType.no_faces;

    await this.core.markStatus(
      job.mediaItemId,
      finalStatus,
      faceCount,
      result.providerKey,
      result.modelVersion,
    );
  }
}
