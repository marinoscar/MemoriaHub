/**
 * Node result-contract DTOs (docs/specs/distributed-nodes.md §6).
 *
 * The COMPUTE half of a node-eligible job runs on the worker node; the
 * PERSIST half stays server-side. These zod schemas define the payload a
 * node submits to `POST /api/nodes/jobs/:jobId/result` for each job type.
 * They live in the shared package so the CLI producer and the API consumer
 * validate against the exact same shapes.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// duplicate_detection (slice 0 — the vertical slice)
// ---------------------------------------------------------------------------

/** Unsigned 64-bit dHash as a decimal string (media_items.perceptual_hash convention). */
const dHashString = z.string().regex(/^\d+$/);

export const duplicateDetectionResultSchema = z.object({
  /** Model tag, e.g. 'clip-vit-b32-q8' (VISUAL_EMBEDDING_MODEL_TAG). */
  model: z.string().min(1),
  /** L2-normalized 512-d CLIP visual embedding. */
  embedding: z.array(z.number()).length(512),
  dHash: dHashString,
});
export type DuplicateDetectionResult = z.infer<typeof duplicateDetectionResultSchema>;

// ---------------------------------------------------------------------------
// face_detection / video_face_detection
// ---------------------------------------------------------------------------

export const faceDetectionResultSchema = z.object({
  modelVersion: z.string().min(1),
  providerKey: z.string().min(1),
  /** Decoded/prepared (post prepareImageForProcessing) pixel dimensions. */
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  faces: z.array(
    z.object({
      /**
       * PIXEL bounding box relative to imageWidth/imageHeight (NOT normalized
       * 0-1) — normalization to the faces-table 0-1 convention happens on the
       * server persist half (mirrors where FaceDetectionCore.normalizeFace
       * runs today for the in-process path).
       */
      boundingBox: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      confidence: z.number().optional(),
      /**
       * Face embedding. Dimensionality is provider-dependent (1024-d for the
       * Human provider, 128-d for CompreFace mobilenet), so no hard length
       * is pinned here — the server-side persist half validates against the
       * active provider's expected dimensions.
       */
      embedding: z.array(z.number()).min(1),
      /**
       * Provider-specific landmark data (e.g. CompreFace facial landmarks).
       * Opaque passthrough — persisted verbatim, never interpreted by the
       * compute/persist split. Absent for providers that don't report
       * landmarks (e.g. the node's Human provider).
       */
      landmarks: z.unknown().optional(),
      /**
       * Provider-assigned face ID for delegated-recognition providers (e.g.
       * AWS Rekognition collections). Absent for keyless/embedding-based
       * providers (Human, CompreFace) and for every node-computed result — a
       * distributed worker node always runs the keyless Human provider, never
       * a delegated one.
       */
      externalFaceId: z.string().optional(),
    }),
  ),
});
export type FaceDetectionResult = z.infer<typeof faceDetectionResultSchema>;

/**
 * video_face_detection — one cluster per detected identity across sampled
 * frames (the compute/persist split's node-submitted result shape). Unlike
 * faceDetectionResultSchema (single photo, pixel-space bbox shared across all
 * faces via top-level imageWidth/imageHeight), each cluster here carries its
 * OWN imageWidth/imageHeight since different sampled frames of the same video
 * can differ in prepared dimensions. `frameThumbnailKey` is optional because
 * uploading the representative-frame JPEG is a best-effort step (a storage
 * upload failure still persists the face, just without a thumbnail key).
 */
export const videoFaceDetectionResultSchema = z.object({
  modelVersion: z.string().min(1),
  providerKey: z.string().min(1),
  clusters: z.array(
    z.object({
      /** PIXEL bounding box relative to this cluster's own imageWidth/imageHeight. */
      boundingBox: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      imageWidth: z.number().int().positive(),
      imageHeight: z.number().int().positive(),
      confidence: z.number().optional(),
      /** Provider-dependent dimensionality, same rationale as faceDetectionResultSchema. */
      embedding: z.array(z.number()).min(1),
      /** Opaque passthrough, same rationale as faceDetectionResultSchema. */
      landmarks: z.unknown().optional(),
      /** Representative frame's appearance timestamp, milliseconds from video start. */
      videoTimestampMs: z.number().int().min(0),
      /** All sampled-frame timestamps where this identity was observed. */
      videoTimestamps: z.array(z.number().int().min(0)).min(1),
      /** Storage key of the uploaded representative-frame JPEG; absent if the upload failed. */
      frameThumbnailKey: z.string().min(1).optional(),
    }),
  ),
});
export type VideoFaceDetectionResult = z.infer<typeof videoFaceDetectionResultSchema>;

// ---------------------------------------------------------------------------
// metadata_extraction
// ---------------------------------------------------------------------------

export const metadataExtractionResultSchema = z.object({
  exif: z.record(z.string(), z.unknown()),
  /** video-probe output; null for photos. */
  probe: z.record(z.string(), z.unknown()).nullable(),
});
export type MetadataExtractionResult = z.infer<typeof metadataExtractionResultSchema>;

// ---------------------------------------------------------------------------
// social_media_detection
// ---------------------------------------------------------------------------

export const socialMediaDetectionResultSchema = z.object({
  verdict: z.enum(['detected', 'clean']),
  /**
   * Legacy/general decision score (0..1) — kept for back-compat with the
   * shape originally proposed in distributed-nodes.md §6. Mirrors
   * `confidence` for a 'detected' verdict; downstream persistence reads
   * `confidence`, not this field.
   */
  score: z.number(),
  ocrText: z.string().nullable(),
  /**
   * Extended beyond the originally-proposed { verdict, score, ocrText } shape
   * (distributed-nodes.md §6) because media_social_status persists platform,
   * detectionMethod, and matchedRule as first-class audit-trail columns — the
   * persist half needs them from the node, it cannot re-derive them from
   * verdict/score alone.
   */
  /** Detected platform; null when verdict='clean' or platform is unresolved. */
  platform: z.enum(['tiktok', 'instagram', 'facebook', 'other']).nullable(),
  /** Tier/method that produced the verdict; null when clean or pre-flight-capped. */
  detectionMethod: z.enum(['metadata', 'filename', 'ocr']).nullable(),
  /**
   * Winning rule/heuristic id (e.g. 'tt-fn-word'), or the pre-flight skip
   * reason (e.g. 'skip-duration-cap', 'skip-size-cap'); null when neither
   * applies (a genuine no-match clean result).
   */
  matchedRule: z.string().nullable(),
  /** Decision confidence in 0..1 — the field media_social_status.confidence persists. */
  confidence: z.number().min(0).max(1),
});
export type SocialMediaDetectionResult = z.infer<typeof socialMediaDetectionResultSchema>;

// ---------------------------------------------------------------------------
// thumbnail_regen / thumbnail_repair
// ---------------------------------------------------------------------------

/**
 * Thumbnail bytes are uploaded FIRST via a presigned PUT (never inline in the
 * result payload); this references what was written.
 */
export const thumbnailResultSchema = z.object({
  storageKey: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Byte length, for server-side sanity validation against the uploaded object. */
  bytes: z.number().int().positive(),
});
export type ThumbnailResult = z.infer<typeof thumbnailResultSchema>;

// ---------------------------------------------------------------------------
// auto_tagging
// ---------------------------------------------------------------------------

/**
 * The RAW, unparsed vision-model response text. Parsing/validation against
 * the enabled TagLabel vocabulary stays server-side (in
 * AutoTaggingService.persistAutoTagging) since it needs a DB-loaded label
 * set — both the in-process compute path and a node submit this same shape.
 */
export const autoTaggingResultSchema = z.object({
  rawText: z.string(),
});
export type AutoTaggingResult = z.infer<typeof autoTaggingResultSchema>;

// ---------------------------------------------------------------------------
// geocode
// ---------------------------------------------------------------------------

export const geocodeResultSchema = z.object({
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
  admin2: z.string().nullable(),
  locality: z.string().nullable(),
  placeName: z.string().nullable(),
  /** Which provider produced this result, e.g. 'nominatim' | 'google'. */
  source: z.string(),
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

// ---------------------------------------------------------------------------
// workflow_execute_batch (Media Workflow Automation — issue #144)
// ---------------------------------------------------------------------------

/**
 * The node-submitted result for a `workflow_execute_batch` job.
 *
 * IMPORTANT — this is a DECLARATION OF INTENDED OUTCOMES, not authoritative
 * state. Unlike every other node-result DTO in this file (where the node does
 * the numeric compute and the server merely persists it), a workflow batch is
 * DB-bound: there is no CPU-heavy compute to offload. The node produces this
 * per-item intent list from the frozen action list carried in the claim
 * `params`, but the API's `persistNodeResult` re-does ALL authoritative work
 * server-side (per-item idempotent claim, drift re-validation, action
 * execution, counters) from the TRUSTED `job.payload` — it does not trust these
 * `items` to decide what to mutate. A stale/forged node result therefore can
 * never bypass the per-item guard or act on items outside the batch. Node
 * eligibility here is about POSTURE COMPLETENESS: an `ENRICHMENT_WORKER_MODE=off`
 * (fleet-only) deployment must still be able to execute workflows.
 */
export const workflowExecuteBatchResultSchema = z.object({
  /** The run this batch belongs to (echoed from the claim params for cross-checking). */
  runId: z.string().min(1),
  /** Per-item intended outcomes the node computed from the frozen action list. */
  items: z.array(
    z.object({
      mediaItemId: z.string().min(1),
      /** The ordered actions the node intended to apply (type only — the server owns the real result). */
      actionResults: z
        .array(
          z.object({
            type: z.string().min(1),
            /** Node-declared intent; the server recomputes the true status, so this is advisory only. */
            status: z.enum(['pending', 'applied', 'skipped', 'failed']).optional(),
          }),
        )
        .optional(),
    }),
  ),
});
export type WorkflowExecuteBatchResult = z.infer<typeof workflowExecuteBatchResultSchema>;
