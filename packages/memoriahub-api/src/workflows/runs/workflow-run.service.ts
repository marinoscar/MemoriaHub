import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import type { MemoriahubRequestUser as RequestUser } from '../../core/index.js';
import { MediaThumbnailService, enqueueEnrichmentJob } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_IDENTITY,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubIdentityPort,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import { isWorkflowsEnabled, readWorkflowSettings, type ResolvedWorkflowSettings as ResolvedSettings } from '../settings/workflows-settings.js';
import {
  WORKFLOW_RUN_ITEM_STATUS,
  WORKFLOW_RUN_STATUS,
  WORKFLOW_TRIGGER,
  type WorkflowRow as Workflow,
  type WorkflowRunRow as WorkflowRun,
  type WorkflowRunStatusKey as WorkflowRunStatus,
  type WorkflowTriggerKey as WorkflowTrigger,
} from '../workflows.constants.js';
import { WorkflowDefinition } from '../definition/workflow-definition.schema.js';
import { getActionDescriptor } from '../registry/subject-registry.js';
import { WorkflowActionDescriptor } from '../registry/field-descriptor.interface.js';
import { resolveMoveTargetScope } from '../actions/move-target.js';

/** Run statuses that are terminal (no further transition). */
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = [
  WORKFLOW_RUN_STATUS.completed,
  WORKFLOW_RUN_STATUS.completed_with_errors,
  WORKFLOW_RUN_STATUS.failed,
  WORKFLOW_RUN_STATUS.cancelled,
  WORKFLOW_RUN_STATUS.expired,
];

/** Statuses counted against the app-wide concurrency gate. */
const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = [
  WORKFLOW_RUN_STATUS.evaluating,
  WORKFLOW_RUN_STATUS.awaiting_approval,
  WORKFLOW_RUN_STATUS.running,
];

/**
 * Media Workflow Automation — run lifecycle service (issue #140).
 *
 * Owns run creation (→ evaluating + enqueues workflow_evaluate), approval
 * (→ running + enqueues workflow_execute_batch chunks), and cancellation. All
 * gated-action authorization (hard_delete feature-flag + media:delete,
 * move_to_circle both-circle collaborator, trash-variant media:delete) happens
 * here at create AND is re-checked at approval; the queue handlers never
 * re-authorize.
 */
@Injectable()
export class WorkflowRunService {
  private readonly logger = new Logger(WorkflowRunService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembership: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_IDENTITY) private readonly identity: MemoriahubIdentityPort,
    private readonly thumbnails: MediaThumbnailService,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=workflow,outcome=cancelled}`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async createRun(
    workflowId: string,
    body: { maxItems?: number },
    user: RequestUser,
  ): Promise<{ runId: string; status: WorkflowRunStatus }> {
    const settings = await this.assertFeatureEnabled();

    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException(`Workflow ${workflowId} not found`);

    await this.circleMembership.requireOwnerRole(
      user.id,
      workflow.circleId,
      user.permissions,
      'editor',
    );

    // App-wide concurrency gate (served by the (status, updatedAt) index).
    const maxConcurrent = settings.workflows?.maxConcurrentRuns ?? 2;
    const active = await this.prisma.workflowRun.count({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= maxConcurrent) {
      throw new ConflictException('Too many concurrent workflow runs');
    }

    const definition = workflow.definition as unknown as WorkflowDefinition;

    // Gated-action authorization at create time (feature flags + system perms +
    // both-circle collaborator for move_to_circle).
    await this.checkGatedActionPermissions(definition, user, workflow.circleId, settings);

    // Snapshot the definition into the run so later workflow edits can't change
    // what this run does. Persisting the JSON into definition_snapshot copies it.
    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        circleId: workflow.circleId,
        status: WORKFLOW_RUN_STATUS.evaluating,
        triggerType: workflow.trigger,
        definitionSnapshot: workflow.definition as unknown,
        startedById: user.id,
      },
    });

    await enqueueEnrichmentJob(this.jobs, {
      type: 'workflow_evaluate',
      circleId: workflow.circleId,
      reason: 'rerun',
      priority: 20,
      payload: { runId: run.id, maxItems: body.maxItems ?? null },
      skipDedup: true,
    });

    this.logTransition(run, run.status, 'run_started', { actorUserId: user.id });
    await this.audit(user.id, 'workflow_run:started', run.id, {
      workflowId: workflow.id,
      circleId: workflow.circleId,
    });

    return { runId: run.id, status: run.status };
  }

  /**
   * Start an UNATTENDED run (scheduled cron trigger or on_media_enriched micro-run
   * dispatch is NOT this path — see the schedule task / evaluate-item handler).
   * Mirrors createRun's body WITHOUT the HTTP concurrency 409 (the scheduler
   * already gated concurrency + overlap) and WITHOUT awaiting_approval — the
   * evaluate handler bypasses approval for any non-manual trigger.
   *
   * Authorization: the acting user is the workflow's creator. Their effective
   * permissions are loaded and gated-action authorization runs up front; a
   * missing permission (or absent creator) returns null instead of crashing the
   * scheduler.
   */
  async startUnattendedRun(
    workflow: Workflow,
    triggerType: WorkflowTrigger,
  ): Promise<{ runId: string } | null> {
    const creatorUserId = workflow.createdById;
    if (!creatorUserId) {
      this.logger.warn(
        `Workflow ${workflow.id} has no creator; cannot authorize an unattended run — skipping`,
      );
      return null;
    }

    const settings = await readWorkflowSettings(this.settings);
    const definition = workflow.definition as unknown as WorkflowDefinition;

    // Synthetic actor built from the creator's effective permissions; gate the
    // actions before committing a run row.
    const permissions = await this.loadUserPermissions(creatorUserId);
    const actor: RequestUser = {
      id: creatorUserId,
      roles: [],
      permissions,
      activeOrgId: null,
    };
    try {
      await this.checkGatedActionPermissions(definition, actor, workflow.circleId, settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Skipping unattended run for workflow ${workflow.id}: creator lacks required authorization (${message})`,
      );
      return null;
    }

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        circleId: workflow.circleId,
        status: WORKFLOW_RUN_STATUS.evaluating,
        triggerType,
        definitionSnapshot: workflow.definition as unknown,
        startedById: creatorUserId,
      },
    });

    await enqueueEnrichmentJob(this.jobs, {
      type: 'workflow_evaluate',
      circleId: workflow.circleId,
      reason: 'rerun',
      priority: 20,
      payload: { runId: run.id, maxItems: null },
      skipDedup: true,
    });

    this.logTransition(run, run.status, 'run_started_unattended', {
      actorUserId: creatorUserId,
    });
    await this.audit(creatorUserId, 'workflow_run:started', run.id, {
      workflowId: workflow.id,
      circleId: workflow.circleId,
      trigger: triggerType,
    });

    return { runId: run.id };
  }

  async approveRun(
    runId: string,
    body: { excludedItemIds?: string[]; confirmation?: string },
    user: RequestUser,
  ): Promise<{ runId: string; status: WorkflowRunStatus }> {
    const settings = await this.assertFeatureEnabled();

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(
      user.id,
      run.circleId,
      user.permissions,
      'editor',
    );

    if (run.status !== WORKFLOW_RUN_STATUS.awaiting_approval) {
      throw new BadRequestException('Run is not awaiting approval');
    }

    const definition = run.definitionSnapshot as unknown as WorkflowDefinition;

    // Exclusions: flip the selected still-matched items to 'excluded'.
    const excluded = body.excludedItemIds ?? [];
    if (excluded.length > 500) {
      throw new BadRequestException('Cannot exclude more than 500 items');
    }
    if (excluded.length > 0) {
      await this.prisma.workflowRunItem.updateMany({
        where: {
          runId: run.id,
          mediaItemId: { in: excluded },
          status: WORKFLOW_RUN_ITEM_STATUS.matched,
        },
        data: { status: WORKFLOW_RUN_ITEM_STATUS.excluded },
      });
    }

    const remainingMatched = await this.prisma.workflowRunItem.count({
      where: { runId: run.id, status: WORKFLOW_RUN_ITEM_STATUS.matched },
    });

    // hard_delete safety confirmation — must match the count shown at preview.
    const hasHardDelete = definition.actions.some(
      (a) => (a as Record<string, unknown>)['type'] === 'hard_delete',
    );
    if (hasHardDelete) {
      const expected = `DELETE ${run.matchedCount}`;
      if (body.confirmation !== expected) {
        throw new BadRequestException(
          `Confirmation required: type "${expected}" to approve a permanent-delete run`,
        );
      }
      await this.audit(user.id, 'workflow_run:hard_delete_approved', run.id, {
        matchedCount: run.matchedCount,
      });
    }

    // Re-authorize gated actions at approval time.
    await this.checkGatedActionPermissions(definition, user, run.circleId, settings);

    const now = new Date();
    const updated = await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: WORKFLOW_RUN_STATUS.running,
        approvedById: user.id,
        approvedAt: now,
        startedAt: now,
      },
    });

    await this.enqueueExecuteBatches(updated, definition, settings);

    this.logTransition(updated, WORKFLOW_RUN_STATUS.running, 'run_approved', {
      actorUserId: user.id,
      remainingMatched,
    });
    await this.audit(user.id, 'workflow_run:approved', run.id, {
      remainingMatched,
      excluded: excluded.length,
    });

    return { runId: run.id, status: WORKFLOW_RUN_STATUS.running };
  }

  async cancelRun(
    runId: string,
    user: RequestUser,
  ): Promise<{ runId: string; status: WorkflowRunStatus }> {
    await this.assertFeatureEnabled();

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);

    await this.circleMembership.requireOwnerRole(
      user.id,
      run.circleId,
      user.permissions,
      'editor',
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: WORKFLOW_RUN_STATUS.cancelled, finishedAt: new Date() },
    });
    this.metrics?.add('runsFinished', 1, { engine: 'workflow', outcome: 'cancelled' });

    this.logTransition(run, WORKFLOW_RUN_STATUS.cancelled, 'run_cancelled', {
      actorUserId: user.id,
    });
    await this.audit(user.id, 'workflow_run:cancelled', run.id, {});

    return { runId: run.id, status: WORKFLOW_RUN_STATUS.cancelled };
  }

  /**
   * Admin override cancel — stops a runaway run app-wide WITHOUT a per-circle
   * membership check (the caller is gated by Admin role + jobs:write at the
   * controller). Same terminal-state guard and cancellation write as the
   * circle-scoped cancelRun; audited as `workflow_run:admin_cancelled`.
   */
  async adminCancelRun(
    runId: string,
    actorUserId: string,
  ): Promise<{ runId: string; status: WorkflowRunStatus }> {
    await this.assertFeatureEnabled();

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: WORKFLOW_RUN_STATUS.cancelled, finishedAt: new Date() },
    });
    this.metrics?.add('runsFinished', 1, { engine: 'workflow', outcome: 'cancelled' });

    this.logTransition(run, WORKFLOW_RUN_STATUS.cancelled, 'run_admin_cancelled', {
      actorUserId,
    });
    await this.audit(actorUserId, 'workflow_run:admin_cancelled', run.id, {});

    return { runId: run.id, status: WORKFLOW_RUN_STATUS.cancelled };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Paginated run history for one workflow (viewer). */
  async listRuns(
    workflowId: string,
    query: { page: number; pageSize: number },
    user: RequestUser,
  ) {
    await this.assertFeatureEnabled();
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException(`Workflow ${workflowId} not found`);
    await this.circleMembership.requireOwnerRole(
      user.id,
      workflow.circleId,
      user.permissions,
      'viewer',
    );

    const { page, pageSize } = query;
    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.workflowRun.findMany({
        where: { workflowId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.workflowRun.count({ where: { workflowId } }),
    ]);

    return {
      items: items.map((r) => this.serializeRun(r)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  /** Run detail incl. counts, per-item status tally, and best-effort action summary (viewer). */
  async getRunDetail(runId: string, user: RequestUser) {
    await this.assertFeatureEnabled();
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);
    await this.circleMembership.requireOwnerRole(
      user.id,
      run.circleId,
      user.permissions,
      'viewer',
    );

    const statusGroups = await this.prisma.workflowRunItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const itemStatusCounts: Record<string, number> = {};
    for (const g of statusGroups) itemStatusCounts[g.status] = g._count._all;

    const actionSummary = await this.buildActionSummary(runId);

    return {
      ...this.serializeRun(run),
      definitionSnapshot: run.definitionSnapshot,
      itemStatusCounts,
      actionSummary,
    };
  }

  /** Paginated run items with batched signed thumbnails (viewer). */
  async listRunItems(
    runId: string,
    query: { status?: string; page: number; pageSize: number },
    user: RequestUser,
  ) {
    await this.assertFeatureEnabled();
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);
    await this.circleMembership.requireOwnerRole(
      user.id,
      run.circleId,
      user.permissions,
      'viewer',
    );

    const { page, pageSize, status } = query;
    const where: Record<string, unknown> = { runId, ...(status ? { status } : {}) };

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.workflowRunItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          mediaItemId: true,
          status: true,
          actionResults: true,
          error: true,
          updatedAt: true,
        },
      }),
      this.prisma.workflowRunItem.count({ where }),
    ]);

    // Batched thumbnail signing for the page's media items.
    const mediaRows = await this.prisma.mediaItem.findMany({
      where: { id: { in: items.map((i) => i.mediaItemId) } },
      select: {
        id: true,
        type: true,
        capturedAt: true,
        originalFilename: true,
        width: true,
        height: true,
        metadata: true,
      },
    });
    const signed = await this.thumbnails.attachThumbnailUrls(mediaRows);
    const byId = new Map(signed.map((m) => [m.id, m]));

    const rows = items.map((i) => {
      const m = byId.get(i.mediaItemId);
      return {
        id: i.id,
        mediaItemId: i.mediaItemId,
        status: i.status,
        actionResults: i.actionResults,
        error: i.error,
        updatedAt: i.updatedAt,
        media: m
          ? {
              type: m.type,
              capturedAt: m.capturedAt,
              filename: m.originalFilename,
              width: m.width,
              height: m.height,
            }
          : null,
        thumbnailUrl: m ? m.thumbnailUrl : null,
      };
    });

    return {
      items: rows,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  /**
   * Best-effort per-action-type rollup from item action_results. Bounded scan —
   * caps rows read so a huge run never scans unbounded history; `partial` flags
   * when the cap was hit.
   */
  private async buildActionSummary(runId: string): Promise<{
    scanned: number;
    partial: boolean;
    byActionType: Record<string, { applied: number; failed: number; skipped: number }>;
  }> {
    const SCAN_CAP = 5000;
    const rows = await this.prisma.workflowRunItem.findMany({
      where: { runId },
      select: { actionResults: true },
      orderBy: { updatedAt: 'desc' },
      take: SCAN_CAP,
    });

    const byActionType: Record<string, { applied: number; failed: number; skipped: number }> = {};
    for (const r of rows) {
      const outcomes = r.actionResults as unknown as
        | Array<{ type?: string; status?: string }>
        | null;
      if (!Array.isArray(outcomes)) continue;
      for (const o of outcomes) {
        if (!o || typeof o.type !== 'string') continue;
        const bucket = (byActionType[o.type] ??= { applied: 0, failed: 0, skipped: 0 });
        if (o.status === 'applied') bucket.applied += 1;
        else if (o.status === 'failed') bucket.failed += 1;
        else bucket.skipped += 1;
      }
    }

    return { scanned: rows.length, partial: rows.length === SCAN_CAP, byActionType };
  }

  /** Serialize a run row for API responses (counts included). */
  private serializeRun(run: WorkflowRun) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      circleId: run.circleId,
      status: run.status,
      triggerType: run.triggerType,
      matchedCount: run.matchedCount,
      truncated: run.truncated,
      processedCount: run.processedCount,
      succeededCount: run.succeededCount,
      failedCount: run.failedCount,
      skippedCount: run.skippedCount,
      startedById: run.startedById,
      approvedById: run.approvedById,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      approvedAt: run.approvedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastError: run.lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared helpers (used by the evaluate handler too)
  // ---------------------------------------------------------------------------

  /**
   * Enqueue one `workflow_execute_batch` job per chunk of still-'matched' item
   * mediaItemIds, sized by `workflows.batchSize`. Shared by approveRun and the
   * approval-bypass path in the evaluate handler so the batching lives in ONE
   * place.
   */
  async enqueueExecuteBatches(
    run: Pick<WorkflowRun, 'id' | 'circleId'>,
    _definition: WorkflowDefinition,
    settings: ResolvedSettings,
  ): Promise<void> {
    const batchSize = settings.workflows?.batchSize ?? 200;

    const items = await this.prisma.workflowRunItem.findMany({
      where: { runId: run.id, status: WORKFLOW_RUN_ITEM_STATUS.matched },
      select: { mediaItemId: true },
    });
    const ids = items.map((i) => i.mediaItemId);

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      await enqueueEnrichmentJob(this.jobs, {
        type: 'workflow_execute_batch',
        circleId: run.circleId,
        reason: 'rerun',
        priority: 100,
        skipDedup: true,
        payload: { runId: run.id, itemIds: chunk },
      });
    }
  }

  /**
   * Approval-bypass rule.
   *
   * UNATTENDED runs (any `triggerType !== 'manual'` — scheduled / on_media_enriched)
   * flow straight into execution per issue #142's shared policy ("No approval
   * stop … everything except hard_delete is allowed"): they have no human to
   * approve, so a stop would strand the run at `awaiting_approval` until it
   * expires. `hard_delete` (the only `manual_only`/destructive action) is already
   * rejected at definition validation for non-manual triggers, and the creator's
   * permissions were gated at `startUnattendedRun` (which skips the run entirely
   * if a required perm is missing). We therefore return `true`, keeping only a
   * defensive `manual_only` assertion (unreachable post-validation).
   *
   * MANUAL runs may skip `awaiting_approval` and execute immediately IFF the
   * per-workflow AND system `requirePreview` are BOTH explicitly false AND the
   * definition contains NO gated action.
   */
  shouldBypassApproval(
    definition: WorkflowDefinition,
    settings: ResolvedSettings,
    triggerType: WorkflowTrigger = WORKFLOW_TRIGGER.manual,
  ): boolean {
    if (triggerType !== WORKFLOW_TRIGGER.manual) {
      // Unattended: straight to execution — refuse only a manual-only action
      // (a safety assertion; definition validation already forbids these here).
      for (const rawAction of definition.actions) {
        const action = rawAction as Record<string, unknown>;
        const descriptor = getActionDescriptor(definition.subject, String(action['type']));
        if (descriptor?.triggerCompatibility === 'manual_only') return false;
      }
      return true;
    }

    // Manual path: requirePreview gate + full gated-action refusal loop.
    if (definition.options?.requirePreview !== false) return false;
    if ((settings.workflows?.requirePreview ?? true) !== false) return false;

    for (const rawAction of definition.actions) {
      const action = rawAction as Record<string, unknown>;
      const descriptor = getActionDescriptor(definition.subject, String(action['type']));
      if (descriptor && this.isGatedAction(descriptor, action)) return false;
    }
    return true;
  }

  /** Resolve a user's effective (distinct) system permission-string list. */
  /**
   * The creator's effective permissions, resolved through the identity port: an unattended run acts as the
   * workflow creator's principal, never as a system superuser.
   */
  private async loadUserPermissions(userId: string): Promise<string[]> {
    return [...(await this.identity.permissionsOf(userId))];
  }

  // ---------------------------------------------------------------------------
  // Authorization / gating
  // ---------------------------------------------------------------------------

  /**
   * True when an action requires elevated scheduling authority: a feature-flag
   * gate, a cross-circle move, a trash-variant requiring media:delete, an
   * irreversible destructive action, or a manual-only action.
   */
  private isGatedAction(
    descriptor: WorkflowActionDescriptor,
    action: Record<string, unknown>,
  ): boolean {
    const perm = descriptor.permission;
    if (perm.gates && perm.gates.length > 0) return true;
    if (perm.bothCircles) return true;
    if (perm.extraPermForTrashVariant && action['action'] === 'trash') return true;
    if (descriptor.destructive) return true;
    if (descriptor.triggerCompatibility === 'manual_only') return true;
    return false;
  }

  /**
   * Enforce every action's system-permission + feature-flag + cross-circle
   * requirements for the acting user. Base media:write is already covered by the
   * @Auth guard + collaborator role, but destructive/gated variants are
   * re-asserted explicitly here.
   */
  private async checkGatedActionPermissions(
    definition: WorkflowDefinition,
    user: RequestUser,
    circleId: string,
    settings: ResolvedSettings,
  ): Promise<void> {
    for (const rawAction of definition.actions) {
      const action = rawAction as Record<string, unknown>;
      const descriptor = getActionDescriptor(definition.subject, String(action['type']));
      if (!descriptor) continue;
      const perm = descriptor.permission;

      // Base system permissions — actor must hold ALL of them.
      this.assertHasPerms(user, perm.systemPerms);

      // hard_delete: require the feature flag on (media:delete already in
      // systemPerms and asserted above).
      if (perm.gates?.includes('workflows.allowHardDelete')) {
        const allow = settings.workflows?.allowHardDelete ?? false;
        if (!allow) {
          throw new ForbiddenException(
            'Hard delete is disabled (workflows.allowHardDelete is off)',
          );
        }
      }

      // Trash variant of burst/duplicate resolve requires media:delete.
      if (perm.extraPermForTrashVariant && action['action'] === 'trash') {
        this.assertHasPerms(user, [perm.extraPermForTrashVariant]);
      }

      // move_to_owner / move_to_circle: editor + systemPerms on BOTH the
      // source and the target library (the alias resolves identically).
      if (perm.bothCircles) {
        const targetCircleId = await resolveMoveTargetScope(action, user.id, this.circleMembership);
        await this.circleMembership.requireOwnerRole(
          user.id,
          circleId,
          user.permissions,
          'editor',
        );
        await this.circleMembership.requireOwnerRole(
          user.id,
          targetCircleId,
          user.permissions,
          'editor',
        );
      }
    }
  }

  private assertHasPerms(user: RequestUser, perms: string[]): void {
    for (const p of perms) {
      if (!user.permissions.includes(p)) {
        throw new ForbiddenException(`Missing required permission: ${p}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------------

  /** Feature gate: 404 when the Workflows feature is disabled. */
  private async assertFeatureEnabled(): Promise<ResolvedSettings> {
    const settings = await readWorkflowSettings(this.settings);
    if (!isWorkflowsEnabled(settings)) {
      throw new NotFoundException('Workflows feature is not enabled');
    }
    return settings;
  }

  /**
   * Structured Pino log line for a run-state transition, always tagged with
   * runId / workflowId / circleId so a run's lifecycle can be traced in the
   * logs. Best-effort — never throws.
   */
  private logTransition(
    run: Pick<WorkflowRun, 'id' | 'workflowId' | 'circleId' | 'triggerType'>,
    toStatus: WorkflowRunStatus,
    event: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log({
      event: `workflow_run.${event}`,
      runId: run.id,
      workflowId: run.workflowId,
      circleId: run.circleId,
      triggerType: run.triggerType,
      status: toStatus,
      ...extra,
    });
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'workflow_run',
        targetId,
        meta: meta as unknown,
      },
    });
  }
}
