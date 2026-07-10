// =============================================================================
// Node compute-result DTOs
// =============================================================================
//
// Request-body schemas for the node result-ingestion endpoints:
//   POST /api/nodes/:id/jobs/:jobId/result   → SubmitJobResultDto
//   POST /api/nodes/:id/jobs/:jobId/failure  → ReportJobFailureDto
//
// Per-job-type RESULT payload schemas also live here for now (currently only
// duplicate_detection). A shared parity package (@memoriahub/enrichment-compute)
// is being built concurrently and will become the canonical home for these —
// this file will then re-export from it. Deliberately import-free of that
// package until it lands.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Endpoint request bodies
// ---------------------------------------------------------------------------

/**
 * Body for POST /nodes/:id/jobs/:jobId/result. `type` must echo the job's
 * type (defense against a node posting a payload against the wrong job);
 * `result` is validated against the handler's own nodeResultSchema.
 */
export const submitJobResultSchema = z.object({
  type: z.string().min(1),
  result: z.unknown(),
});

export class SubmitJobResultDto extends createZodDto(submitJobResultSchema) {}

/**
 * Body for POST /nodes/:id/jobs/:jobId/failure. Matches the shipped CLI body
 * `{ error, willRetry }`; the extra fields are optional forward-compat.
 * `willRetry` is advisory only — the server's attempts budget decides whether
 * the job is requeued or permanently failed.
 */
export const reportJobFailureSchema = z.object({
  error: z.string().min(1),
  willRetry: z.boolean().optional(),
  rateLimited: z.boolean().optional(),
  retryAfterMs: z.number().int().min(0).nullable().optional(),
});

export class ReportJobFailureDto extends createZodDto(reportJobFailureSchema) {}

// ---------------------------------------------------------------------------
// Per-job-type result payload schemas
// ---------------------------------------------------------------------------

/**
 * Result payload a node submits for a `duplicate_detection` job: the CLIP
 * ViT-B/32 visual embedding (512-d) plus the 64-bit dHash as a decimal string
 * (unsigned 64-bit — NEVER a number/bigint; see the perceptual_hash storage
 * rationale in CLAUDE.md).
 */
export const duplicateDetectionNodeResultSchema = z.object({
  model: z.string().min(1),
  embedding: z.array(z.number()).length(512),
  dHash: z.string().regex(/^\d+$/),
});

export type DuplicateDetectionNodeResult = z.infer<typeof duplicateDetectionNodeResultSchema>;
