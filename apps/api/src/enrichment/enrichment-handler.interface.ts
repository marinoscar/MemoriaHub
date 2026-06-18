import { EnrichmentJob } from '@prisma/client';

export const ENRICHMENT_HANDLER = Symbol('ENRICHMENT_HANDLER');

export interface EnrichmentHandler {
  readonly type: string; // e.g. 'face_detection'
  process(job: EnrichmentJob): Promise<void>; // throw on failure → worker retries
}
