/**
 * node/compute/video-face-detection.ts — Video face-detection compute.
 *
 * Runs the full video face-detection compute locally via the shared
 * `@memoriahub/enrichment-compute` parity package so a node's cross-frame
 * face clusters are numerically identical to the server's for the same
 * input video (distributed-nodes spec §7). Mirrors the server-side
 * `VideoFaceDetectionService.computeVideoFaces` pipeline:
 *
 *   1. Probe the downloaded video's own duration via ffprobe
 *      (`probeVideo`/`extractContainerMetadata` from `/metadata`).
 *   2. Sample frames via ffmpeg (`extractFrames` from `/video`), using
 *      `sampleIntervalSeconds`/`maxFramesPerVideo` from `params` — merged in
 *      server-side by `NodesService.claim()` from the `face.video.*` system
 *      settings — falling back to the server's own defaults (5s / 60 frames)
 *      for an older server that doesn't yet supply them.
 *   3. Per frame: EXIF-orient + downscale via `prepareImageForProcessing`
 *      (same `FACE_MAX_IMAGE_DIM` the photo path uses), then detect via the
 *      configured provider — the keyless Human WASM provider (1024-d
 *      embeddings, default) or, when this node's `faceProvider` config is
 *      `'compreface'`, a locally-running compreface-core sidecar (128-d
 *      embeddings). Same hard-fail philosophy as the photo path: an
 *      unreachable CompreFace sidecar is a hard compute error, never a
 *      silent fallback to Human.
 *   4. Cluster all per-frame detections across the whole video by embedding
 *      cosine similarity (`clusterFaceDetections` from `/face-video`) —
 *      `isDelegated` is always `false` on a node, since both Human and
 *      CompreFace are keyless/embedding-based providers; a node never runs a
 *      delegated-recognition provider like Rekognition.
 *   5. Per cluster: build a face-centered thumbnail crop of the
 *      representative detection's frame (`buildFaceCropThumbnail` from
 *      `/face-video`) and upload it via the node's generic per-job upload-URL
 *      endpoint. A single cluster's thumbnail build/upload failure is
 *      non-fatal — that cluster is still submitted, just without a
 *      `frameThumbnailKey` — mirroring the server's own best-effort handling
 *      of this step.
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'video_face_detection'`
 * (`videoFaceDetectionResultSchema`, `packages/enrichment-compute/src/dto`):
 * `{ modelVersion, providerKey, clusters: [{ boundingBox px (relative to that
 * cluster's own imageWidth/imageHeight), imageWidth, imageHeight, confidence?,
 * embedding, landmarks?, videoTimestampMs, videoTimestamps, frameThumbnailKey? }] }`.
 *
 * Bounding-box space note: detector output (Human/CompreFace) is PIXEL-space
 * relative to the specific frame it was detected on. Clustering itself
 * operates on NORMALIZED (0-1) boxes (`ClusterableDetection.boundingBox`) so
 * cosine-similarity-based identity matching is comparable across frames of
 * differing prepared dimensions; the final persisted/submitted boundingBox is
 * PIXEL-space again, taken from the cluster representative's own original
 * (never-normalized) detection — never re-derived from the normalized
 * clustering box. This mirrors the server's `DetectionPayload`/`normalizeFace`
 * split exactly (see `VideoFaceDetectionService.computeVideoFaces`).
 */

import fs from 'node:fs';
import path from 'node:path';

import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import {
  createFaceDetector,
  FACE_MODEL_VERSION,
  FACE_PROVIDER_KEY,
  type FaceDetector,
} from '@memoriahub/enrichment-compute/face';
import {
  detectComprefaceFaces,
  COMPREFACE_MODEL_VERSION,
  COMPREFACE_PROVIDER_KEY,
} from '@memoriahub/enrichment-compute/face-compreface';
import { probeVideo, extractContainerMetadata } from '@memoriahub/enrichment-compute/metadata';
import { extractFrames } from '@memoriahub/enrichment-compute/video';
import {
  clusterFaceDetections,
  buildFaceCropThumbnail,
  DEFAULT_FACE_CLUSTER_THRESHOLD,
  type ClusterableDetection,
} from '@memoriahub/enrichment-compute/face-video';

import { loadConfig } from '../../config.js';
import { modelsDir } from '../../paths.js';
import { ApiClient } from '../../api.js';
import { CapabilityUnavailableError, DEFAULT_COMPREFACE_URL, type ComputeFn } from '../capabilities.js';

/**
 * Downscale ceiling before detection — MUST match the photo path's
 * FACE_MAX_IMAGE_DIM (see ./face-detection.ts) and the server's
 * FACE_MAX_IMAGE_DIM default, so a node and the server detect against
 * identically-sized frame inputs and produce comparable pixel-space
 * bounding boxes.
 */
const FACE_MAX_IMAGE_DIM = 2000;

/** Server default (`face.video.sampleIntervalSeconds`) — fallback only. */
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 5;
/** Server default (`face.video.maxFramesPerVideo`) — fallback only. */
const DEFAULT_MAX_FRAMES_PER_VIDEO = 60;

/**
 * Module-level lazy singleton for the Human face detector — model load +
 * warmup costs real time, so it is cached across jobs for the lifetime of the
 * worker process. Shared instance/cache-key scheme mirrors ./face-detection.ts
 * exactly (same modelBasePath resolution, same singleton behavior).
 */
let detectorPromise: Promise<FaceDetector> | null = null;

function resolveModelBasePath(): string {
  const override = process.env['FACE_HUMAN_MODEL_PATH'];
  if (override) return override;
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), 'human');
}

function getFaceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    const modelBasePath = resolveModelBasePath();
    if (!fs.existsSync(modelBasePath)) {
      throw new CapabilityUnavailableError(
        `Human face model not present at ${modelBasePath} — run \`node doctor\`/\`node start\` to download models`,
        'human',
      );
    }
    detectorPromise = createFaceDetector({ modelBasePath }).catch((err: unknown) => {
      detectorPromise = null; // allow retry on a later job
      throw err;
    });
  }
  return detectorPromise;
}

/**
 * Host-specific data carried through clustering for each detection, mirroring
 * the server's `DetectionPayload` (VideoFaceDetectionService): the prepared
 * frame buffer/dimensions (for thumbnail cropping) plus the raw, never-
 * normalized PIXEL bounding box + provider landmarks (for final DTO
 * assembly).
 */
interface DetectionPayload {
  frameBuffer: Buffer;
  frameWidth: number;
  frameHeight: number;
  pixelBoundingBox: { x: number; y: number; width: number; height: number };
  landmarks?: unknown;
}

const computeVideoFaceDetection: ComputeFn = async (inputPath, params, ctx) => {
  // Thumbnail upload needs { nodeId, jobId } to call the node's generic
  // per-job upload-URL endpoint — see ./thumbnail.ts for the identical guard
  // rationale. The running node engine always supplies ctx on every claimed
  // job dispatch, so seeing this error means the dispatcher was invoked
  // directly without it (e.g. a test harness).
  if (!ctx) {
    throw new Error(
      'job context not provided — video face-detection compute needs { nodeId, jobId } to ' +
        'request thumbnail upload URLs via ComputeDispatcher.compute(); the running node engine ' +
        'always supplies this, so seeing this error means the dispatcher was invoked directly ' +
        'without it (e.g. from a test harness) — see ../capabilities.ts',
    );
  }

  const cfg = loadConfig();
  const faceProvider = cfg?.node?.faceProvider ?? 'human';
  // Thumbnail upload is best-effort per cluster (see step 5 below) — a node
  // not logged in simply submits clusters without frameThumbnailKey rather
  // than failing the whole job.
  const client = cfg ? new ApiClient({ serverUrl: cfg.serverUrl, pat: cfg.pat }) : null;

  const p = params as Record<string, unknown>;
  const sampleIntervalSeconds =
    typeof p['sampleIntervalSeconds'] === 'number'
      ? p['sampleIntervalSeconds']
      : DEFAULT_SAMPLE_INTERVAL_SECONDS;
  const maxFrames =
    typeof p['maxFramesPerVideo'] === 'number' ? p['maxFramesPerVideo'] : DEFAULT_MAX_FRAMES_PER_VIDEO;

  // --- 1. Probe the video's own duration (the node has the file locally, so
  //         it probes its own duration rather than relying on server-side
  //         MediaItem metadata) ---
  const probeData = await probeVideo(inputPath);
  const container = extractContainerMetadata(probeData);
  const durationMs = container.durationMs ?? null;

  // --- 2. Sample frames via ffmpeg ---
  const frames = await extractFrames(inputPath, {
    durationMs,
    sampleIntervalSeconds,
    maxFrames,
    fileExtension: path.extname(inputPath) || '.mp4',
  });

  // --- 3. Detect faces per frame, building the clustering input list ---
  const allDetections: ClusterableDetection<DetectionPayload>[] = [];

  for (const frame of frames) {
    const prepared = await prepareImageForProcessing(frame.buffer, { maxDim: FACE_MAX_IMAGE_DIM });
    const frameBuffer = prepared.width > 0 && prepared.height > 0 ? prepared.buffer : frame.buffer;

    if (faceProvider === 'compreface') {
      const comprefaceUrl = cfg?.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL;
      // No catch-and-fallback here: an unreachable sidecar must surface as a
      // normal compute error, routed through the engine's existing /failure +
      // retry/backoff path — never a silent degrade to the Human provider
      // (same hard-fail philosophy as ./face-detection.ts).
      const faces = await detectComprefaceFaces(comprefaceUrl, frameBuffer);

      let frameWidth = prepared.width;
      let frameHeight = prepared.height;
      if (frameWidth === 0 || frameHeight === 0) {
        try {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(frameBuffer).metadata();
          frameWidth = meta.width ?? 0;
          frameHeight = meta.height ?? 0;
        } catch {
          // leave at 0 — this frame's detections are skipped below.
        }
      }
      // Dimensions are required to normalize boxes for clustering; a frame
      // whose dimensions can't be determined contributes no detections
      // rather than corrupting the clustering input with divide-by-zero
      // normalized boxes.
      if (frameWidth === 0 || frameHeight === 0) continue;

      for (const face of faces) {
        allDetections.push({
          embedding: face.embedding ?? [],
          confidence: face.confidence,
          boundingBox: {
            x: face.boundingBox.x / frameWidth,
            y: face.boundingBox.y / frameHeight,
            w: face.boundingBox.w / frameWidth,
            h: face.boundingBox.h / frameHeight,
          },
          timestampMs: frame.timestampMs,
          payload: {
            frameBuffer,
            frameWidth,
            frameHeight,
            pixelBoundingBox: {
              x: face.boundingBox.x,
              y: face.boundingBox.y,
              width: face.boundingBox.w,
              height: face.boundingBox.h,
            },
            landmarks: face.landmarks,
          },
        });
      }
      continue;
    }

    const detector = await getFaceDetector();
    const { width: frameWidth, height: frameHeight, faces } = await detector.detect(frameBuffer);
    if (frameWidth === 0 || frameHeight === 0) continue;

    for (const face of faces) {
      allDetections.push({
        embedding: face.embedding ?? [],
        confidence: face.confidence,
        boundingBox: {
          x: face.boundingBox.x / frameWidth,
          y: face.boundingBox.y / frameHeight,
          w: face.boundingBox.width / frameWidth,
          h: face.boundingBox.height / frameHeight,
        },
        timestampMs: frame.timestampMs,
        payload: {
          frameBuffer,
          frameWidth,
          frameHeight,
          // ComputeDetectedFace.boundingBox is already { x, y, width, height }
          // in PIXEL space — no remapping needed (unlike CompreFace's w/h).
          pixelBoundingBox: face.boundingBox,
        },
      });
    }
  }

  // --- 4. Cluster across frames (isDelegated=false — both providers here are
  //         keyless/embedding-based; a node never runs a delegated provider) ---
  const clusters = clusterFaceDetections(allDetections, DEFAULT_FACE_CLUSTER_THRESHOLD, false);

  // --- 5. Per cluster: best-effort thumbnail crop + upload, then assemble ---
  const resultClusters: Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
    imageWidth: number;
    imageHeight: number;
    confidence?: number;
    embedding: number[];
    landmarks?: unknown;
    videoTimestampMs: number;
    videoTimestamps: number[];
    frameThumbnailKey?: string;
  }> = [];

  for (const cluster of clusters) {
    const rep = cluster.representative;

    let frameThumbnailKey: string | undefined;
    if (client) {
      try {
        const thumbBuffer = await buildFaceCropThumbnail(rep.payload.frameBuffer, {
          boundingBox: rep.boundingBox,
        });
        const { url, storageKey } = await client.getJobUploadUrl(ctx.nodeId, ctx.jobId);
        await client.putRaw(url, thumbBuffer, 'image/jpeg');
        frameThumbnailKey = storageKey;
      } catch {
        // Non-fatal: this cluster is still submitted, just without a
        // frameThumbnailKey (schema field is optional for exactly this case).
      }
    }

    resultClusters.push({
      boundingBox: rep.payload.pixelBoundingBox,
      imageWidth: rep.payload.frameWidth,
      imageHeight: rep.payload.frameHeight,
      confidence: rep.confidence,
      embedding: rep.embedding,
      landmarks: rep.payload.landmarks,
      videoTimestampMs: rep.timestampMs,
      videoTimestamps: [...cluster.allTimestampsMs].sort((a, b) => a - b),
      ...(frameThumbnailKey ? { frameThumbnailKey } : {}),
    });
  }

  const modelVersion = faceProvider === 'compreface' ? COMPREFACE_MODEL_VERSION : FACE_MODEL_VERSION;
  const providerKey = faceProvider === 'compreface' ? COMPREFACE_PROVIDER_KEY : FACE_PROVIDER_KEY;

  return {
    modelVersion,
    providerKey,
    clusters: resultClusters,
  };
};

export default computeVideoFaceDetection;
