import { EnrichmentJob } from '@prisma/client';
import type { z } from 'zod';

export const ENRICHMENT_HANDLER = Symbol('ENRICHMENT_HANDLER');

/**
 * Image-based enrichment handlers MUST load pixels via prepareImageForProcessing
 * (storage/processing/image-orientation.util) — never decode raw bytes directly —
 * so EXIF orientation is always applied.
 */
export interface EnrichmentHandler {
  readonly type: string; // e.g. 'face_detection'
  process(job: EnrichmentJob): Promise<void>; // throw on failure → worker retries

  /**
   * OPTIONAL node-result persistence (distributed workers). Present only on
   * node-eligible handlers — a handler that implements BOTH members below can
   * accept a remotely-computed result via POST /api/nodes/:id/jobs/:jobId/result
   * instead of running process() on the server.
   *
   * Zod schema the raw node-submitted result payload must satisfy before it is
   * handed to persistNodeResult.
   */
  readonly nodeResultSchema?: z.ZodType;

  /**
   * Persist a node-computed result (already validated against nodeResultSchema)
   * for the given job. Must perform ONLY the persist half of the compute/persist
   * split — no recompute, no downloads. Throw on failure → the job routes
   * through the normal failure/retry path.
   */
  persistNodeResult?(job: EnrichmentJob, result: unknown): Promise<void>;
}
