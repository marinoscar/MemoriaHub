import { EnrichmentJob } from '@prisma/client';

export const ENRICHMENT_HANDLER = Symbol('ENRICHMENT_HANDLER');

/**
 * Image-based enrichment handlers MUST load pixels via prepareImageForProcessing
 * (storage/processing/image-orientation.util) — never decode raw bytes directly —
 * so EXIF orientation is always applied.
 */
export interface EnrichmentHandler {
  readonly type: string; // e.g. 'face_detection'
  process(job: EnrichmentJob): Promise<void>; // throw on failure → worker retries
}
