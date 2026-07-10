// =============================================================================
// Node compute-result DTOs
// =============================================================================
//
// Request-body schemas for the node result-ingestion endpoints:
//   POST /api/nodes/:id/jobs/:jobId/result   → SubmitJobResultDto
//   POST /api/nodes/:id/jobs/:jobId/failure  → ReportJobFailureDto
//
// Per-job-type RESULT payload schemas live in the shared parity package
// (@memoriahub/enrichment-compute/dto) so the CLI producer and the API
// consumer validate against the exact same shapes; they are re-exported at
// the bottom of this file for API-layer convenience. Only the endpoint
// request-body DTOs are defined locally.
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
// Per-job-type result payload schemas (canonical home: shared parity package)
// ---------------------------------------------------------------------------

export {
  duplicateDetectionResultSchema,
  faceDetectionResultSchema,
  metadataExtractionResultSchema,
  socialMediaDetectionResultSchema,
  thumbnailResultSchema,
} from '@memoriahub/enrichment-compute/dto';
export type {
  DuplicateDetectionResult,
  FaceDetectionResult,
  MetadataExtractionResult,
  SocialMediaDetectionResult,
  ThumbnailResult,
} from '@memoriahub/enrichment-compute/dto';
