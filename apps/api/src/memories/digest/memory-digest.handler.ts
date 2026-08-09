// =============================================================================
// Memory Digest Enrichment Handler (epic #300, issue #311)
// =============================================================================
//
// Runs one circle's digest send. Enqueued once per due circle by
// MemoryDigestTask.
//
// SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair, so
// EnrichmentHandlerRegistry.serverOnlyTypes() picks the type up automatically
// and it becomes eligible for the ENRICHMENT_WORKER_MODE=system claim set with
// no explicit pinning — the same inference that covers `memory_generation`,
// `face_auto_archive_sweep` and the `location_inference` sweep. There is no
// per-item unit of work to hand a node, and the send needs a server-held email
// credential plus the `SECRETS_ENCRYPTION_KEY`-derived signing key that a node
// never holds. It is correspondingly ABSENT from the CLI's NODE_JOB_TYPES.
//
// WHY IT IS A JOB AT ALL, rather than in-process work like ShareExpiringTask's
// sweep: sending is the one part of this feature that talks to a third party,
// so it is the part that genuinely fails transiently. Being a job row gives it
// the queue's retry budget, makes a stuck send visible in /admin/settings/jobs,
// and bounds a broken provider to ENRICHMENT_MAX_ATTEMPTS instead of an hourly
// silent failure nobody sees. (#246's reconcile is in-process for the opposite
// reason: it is pure local SQL that cannot fail transiently.)
//
// RETRY SEMANTICS. `process` throws only when the send pass itself blew up
// (an infrastructure error). Every per-recipient failure is counted inside
// MemoryDigestService and the job SUCCEEDS, because a retry would re-mail
// everybody the first pass already reached — there is no per-recipient
// checkpoint, and duplicate mail is worse than a missed one. A closed gate is
// likewise a SUCCESS, not a failure: a disabled feature is not an error, and
// failing would burn retry attempts and light up the dashboard for no reason
// (same posture as MemoryGenerationHandler).
//
// THE WATERMARK IS THE JOB ROW ITSELF. Nothing is written to record "the digest
// was sent" — `finishedAt` of this succeeded row IS the watermark the next
// period reads (see MemoryDigestService.lastDigestAt). That is what makes a
// hand-retry from the admin dashboard safe to reason about, and it is why the
// handler must not fail on a partial send: a failed row is not a watermark, so
// the next tick would re-send everything.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';

import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { MEMORY_DIGEST_JOB_TYPE, MemoryDigestService } from './memory-digest.service';

@Injectable()
export class MemoryDigestHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = MEMORY_DIGEST_JOB_TYPE;

  private readonly logger = new Logger(MemoryDigestHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly digest: MemoryDigestService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.circleId) {
      // A digest is per circle by construction; a circle-less row has nothing
      // to send. Not an error — nothing to do.
      this.logger.warn(`memory_digest job ${job.id} has no circleId; nothing to send`);
      return;
    }

    const result = await this.digest.sendForCircle(job.circleId);

    // Quiet when the run was a deliberate no-op (gate closed, or no new content
    // since the watermark) — that is the expected steady state for most circles
    // most of the time and an hourly log line saying so is noise.
    if (result.skippedReason) {
      this.logger.debug(
        `memory_digest job ${job.id} (circle ${job.circleId}) skipped: ${result.skippedReason}`,
      );
      return;
    }

    this.logger.log({
      event: 'memory_digest.completed',
      jobId: job.id,
      circleId: job.circleId,
      candidates: result.candidates,
      recipients: result.recipients,
      sent: result.sent,
      skippedOptOut: result.skippedOptOut,
      skippedEmpty: result.skippedEmpty,
      skippedNoEmail: result.skippedNoEmail,
      failed: result.failed,
    });
  }
}
