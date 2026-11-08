// The enqueue facade lives with the platform adoption (RETRO-C1, #575); this
// path stays so the ~60 import sites do not change in the cutover.
export { EnrichmentJobService } from '../platform/jobs/enrichment-job.facade';
export type { EnqueueInput } from '../platform/jobs/enrichment-job.facade';
