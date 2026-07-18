import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  EnrichmentJob,
  Prisma,
  WorkflowRun,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { WorkflowRunService } from './workflow-run.service';

/** Payload shape for a `workflow_evaluate` job. */
interface WorkflowEvaluatePayload {
  runId: string;
  maxItems?: number | null;
}

/** Keyset page size for streaming the matched-item scan. */
const PAGE_SIZE = 1000;

/** OTEL tracer for the Media Workflow Automation compute path. */
const tracer = trace.getTracer('workflows');

/**
 * Media Workflow Automation — evaluation handler (issue #140).
 *
 * Materializes a run's matched item set into workflow_run_items (status
 * 'matched') via constant-memory keyset pagination over the gallery ordering
 * (capturedAt DESC NULLS LAST, id DESC), applying compiled read-time refinements
 * per page and streaming each accepted page straight into the DB — never holds
 * the full id set in memory. Then transitions the run:
 *   - 0 matches         → completed
 *   - bypass eligible   → running (+ execute batches)
 *   - otherwise         → awaiting_approval
 */
@Injectable()
export class WorkflowEvaluateHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'workflow_evaluate';

  private readonly logger = new Logger(WorkflowEvaluateHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly compiler: WorkflowConditionCompiler,
    private readonly runService: WorkflowRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as WorkflowEvaluatePayload | null;
    if (!payload?.runId) {
      this.logger.warn(`workflow_evaluate job ${job.id} missing runId payload; skipping`);
      return;
    }
    const runId = payload.runId;

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== WorkflowRunStatus.evaluating) return;

    // OTEL span around the whole evaluation pass, tagged with run/workflow/circle.
    await tracer.startActiveSpan(
      'workflow.evaluate',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'workflow.run_id': run.id,
          'workflow.id': run.workflowId,
          'workflow.circle_id': run.circleId,
        },
      },
      async (span) => {
        try {
          await this.runEvaluation(job, run, payload);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Structured Pino log for a run transition, tagged with run/workflow/circle. */
  private logTransition(run: WorkflowRun, toStatus: WorkflowRunStatus, extra: Record<string, unknown> = {}): void {
    this.logger.log({
      event: 'workflow_run.evaluated',
      runId: run.id,
      workflowId: run.workflowId,
      circleId: run.circleId,
      status: toStatus,
      ...extra,
    });
  }

  private async runEvaluation(
    job: EnrichmentJob,
    run: WorkflowRun,
    payload: WorkflowEvaluatePayload,
  ): Promise<void> {
    const runId = run.id;
    try {
      const settings = await this.systemSettings.getSettings();
      const definition = run.definitionSnapshot as unknown as WorkflowDefinition;
      const compiled = this.compiler.compile(run.circleId, definition);

      // Effective cap: run-body override wins if smaller, then per-workflow
      // options.maxItems, then the system ceiling.
      const caps: number[] = [settings.workflows?.maxItemsPerRun ?? 10000];
      if (payload.maxItems != null) caps.push(payload.maxItems);
      if (definition.options?.maxItems != null) caps.push(definition.options.maxItems);
      const cap = Math.min(...caps);

      const needRefine = compiled.refinements.length > 0;
      const select: Prisma.MediaItemSelect = { id: true, capturedAt: true };
      if (needRefine) {
        for (const r of compiled.refinements) Object.assign(select, r.select);
      }

      const orderBy: Prisma.MediaItemOrderByWithRelationInput[] = [
        { capturedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ];

      let accepted = 0;
      let truncated = false;
      let cursor: { capturedAt: Date | null; id: string } | null = null;

      for (;;) {
        const where: Prisma.MediaItemWhereInput = cursor
          ? { AND: [compiled.where, this.buildAfterCursor(cursor)] }
          : compiled.where;

        const rows = (await this.prisma.mediaItem.findMany({
          where,
          orderBy,
          take: PAGE_SIZE,
          select,
        })) as Array<{ id: string; capturedAt: Date | null }>;

        if (rows.length === 0) break;

        // Advance the cursor using the RAW ordering (before refinement filtering).
        const last = rows[rows.length - 1];
        cursor = { capturedAt: last.capturedAt, id: last.id };

        const matched = needRefine
          ? rows.filter((row) => compiled.refinements.every((r) => r.predicate(row)))
          : rows;

        // Respect the cap: trim the final page so we never insert more than cap.
        let toInsert = matched;
        if (accepted + matched.length > cap) {
          toInsert = matched.slice(0, cap - accepted);
          truncated = true; // there were more matching rows than we accepted
        }

        if (toInsert.length > 0) {
          await this.prisma.workflowRunItem.createMany({
            data: toInsert.map((r) => ({
              runId,
              mediaItemId: r.id,
              status: WorkflowRunItemStatus.matched,
            })),
            skipDuplicates: true,
          });
          accepted += toInsert.length;
        }

        if (accepted >= cap) {
          // Exact-boundary case: filled to cap without trimming but more pages
          // may hold matches — do one bounded lookahead to set `truncated`.
          if (!truncated && rows.length === PAGE_SIZE) {
            truncated = await this.hasMoreMatching(compiled, cursor, needRefine, select);
          }
          break;
        }

        if (rows.length < PAGE_SIZE) break; // last page
      }

      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: { matchedCount: accepted, truncated },
      });

      if (accepted === 0) {
        await this.prisma.workflowRun.update({
          where: { id: runId },
          data: { status: WorkflowRunStatus.completed, finishedAt: new Date() },
        });
        await this.audit(run.startedById, 'workflow_run:completed', runId, {
          matchedCount: 0,
        });
        this.logTransition(run, WorkflowRunStatus.completed, { matchedCount: 0 });
        return;
      }

      if (this.runService.shouldBypassApproval(definition, settings, run.triggerType)) {
        const running = await this.prisma.workflowRun.update({
          where: { id: runId },
          data: { status: WorkflowRunStatus.running, startedAt: new Date() },
        });
        await this.runService.enqueueExecuteBatches(running, definition, settings);
        this.logTransition(run, WorkflowRunStatus.running, { matchedCount: accepted, truncated });
        return;
      }

      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: { status: WorkflowRunStatus.awaiting_approval },
      });
      this.logTransition(run, WorkflowRunStatus.awaiting_approval, {
        matchedCount: accepted,
        truncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the run terminally failed only once the job has exhausted its normal
      // retries (attempts is charged at claim time), so intermediate attempts
      // still re-run (the run stays 'evaluating' and re-materializes idempotently
      // via createMany skipDuplicates). Then rethrow so the job itself fails too.
      const maxAttempts = this.maxAttempts();
      if (job.attempts >= maxAttempts) {
        await this.prisma.workflowRun
          .update({
            where: { id: runId },
            data: {
              status: WorkflowRunStatus.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        this.logTransition(run, WorkflowRunStatus.failed, { error: message });
      }
      throw err;
    }
  }

  /**
   * Keyset "strictly after cursor" predicate for the (capturedAt DESC NULLS
   * LAST, id DESC) ordering. Non-null cursor: lower capturedAt, or equal
   * capturedAt with lower id, or any null-capturedAt row (nulls sort last).
   * Null cursor (already in the trailing null block): null capturedAt with lower id.
   */
  private buildAfterCursor(cursor: {
    capturedAt: Date | null;
    id: string;
  }): Prisma.MediaItemWhereInput {
    if (cursor.capturedAt === null) {
      return { capturedAt: null, id: { lt: cursor.id } };
    }
    return {
      OR: [
        { capturedAt: { lt: cursor.capturedAt } },
        { AND: [{ capturedAt: cursor.capturedAt }, { id: { lt: cursor.id } }] },
        { capturedAt: null },
      ],
    };
  }

  /** One bounded page lookahead: does any refined match exist beyond the cursor? */
  private async hasMoreMatching(
    compiled: ReturnType<WorkflowConditionCompiler['compile']>,
    cursor: { capturedAt: Date | null; id: string },
    needRefine: boolean,
    select: Prisma.MediaItemSelect,
  ): Promise<boolean> {
    const rows = (await this.prisma.mediaItem.findMany({
      where: { AND: [compiled.where, this.buildAfterCursor(cursor)] },
      orderBy: [{ capturedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: PAGE_SIZE,
      select,
    })) as Array<{ id: string; capturedAt: Date | null }>;
    if (rows.length === 0) return false;
    if (!needRefine) return true;
    return rows.some((row) => compiled.refinements.every((r) => r.predicate(row)));
  }

  private maxAttempts(): number {
    const raw = parseInt(process.env['ENRICHMENT_MAX_ATTEMPTS'] ?? '3', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
  }

  private async audit(
    actorUserId: string | null,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (!actorUserId) return;
    await this.prisma.auditEvent
      .create({
        data: {
          actorUserId,
          action,
          targetType: 'workflow_run',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}
