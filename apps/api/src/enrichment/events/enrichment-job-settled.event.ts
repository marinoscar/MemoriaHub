import { JobReason } from '@prisma/client';

/**
 * Generic domain event emitted once an enrichment job reaches a TERMINAL state
 * (succeeded, or failed after exhausting retries/rate-limit deferrals) by the
 * single shared chokepoint EnrichmentTerminalService — covering BOTH the
 * in-process worker and node-reported results/failures.
 *
 * NOT emitted on a requeue/deferral (only on the truly terminal transition).
 * Additive and behavior-preserving. Consumed by WorkflowTriggerListener (Media
 * Workflow Automation, on_media_enriched trigger, issue #142); intentionally
 * generic so other features can subscribe.
 */
export const ENRICHMENT_JOB_SETTLED_EVENT = 'enrichment.job.settled';

export class EnrichmentJobSettledEvent {
  constructor(
    readonly jobId: string,
    readonly type: string,
    readonly reason: JobReason,
    readonly mediaItemId: string | null,
    readonly circleId: string | null,
    readonly outcome: 'succeeded' | 'failed',
  ) {}
}
