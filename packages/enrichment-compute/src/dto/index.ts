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
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  faces: z.array(
    z.object({
      /** Normalized 0–1 bounding box, matching the faces table convention. */
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
    }),
  ),
});
export type FaceDetectionResult = z.infer<typeof faceDetectionResultSchema>;

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
  score: z.number(),
  ocrText: z.string().nullable(),
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
