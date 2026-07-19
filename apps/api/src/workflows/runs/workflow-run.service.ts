import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  JobReason,
  Prisma,
  Workflow,
  WorkflowRun,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
  WorkflowTrigger,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { isWorkflowsEnabled } from '../../common/types/settings.types';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { getActionDescriptor } from '../registry/subject-registry';
import { WorkflowActionDescriptor } from '../registry/field-descriptor.interface';

/** The resolved settings object returned by SystemSettingsService.getSettings(). */
type ResolvedSettings = Awaited<ReturnType<SystemSettingsService['getSettings']>>;

/** Run statuses that are terminal (no further transition). */
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.completed,
  WorkflowRunStatus.completed_with_errors,
  WorkflowRunStatus.failed,
  WorkflowRunStatus.cancelled,
  WorkflowRunStatus.expired,
];

/** Statuses counted against the app-wide concurrency gate. */
const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.evaluating,
  WorkflowRunStatus.awaiting_approval,
  WorkflowRunStatus.running,
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
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly circleMembership: CircleMembershipService,
    private readonly enrichmentJobs: EnrichmentJobService,
    private readonly thumbnails: MediaThumbnailService,
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

    await this.circleMembership.assertCircleAccess(
      user.id,
      workflow.circleId,
      user.permissions,
      CircleRole.collaborator,
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
        status: WorkflowRunStatus.evaluating,
        triggerType: workflow.trigger,
        definitionSnapshot: workflow.definition as Prisma.InputJsonValue,
        startedById: user.id,
      },
    });

    await this.enrichmentJobs.enqueue({
      type: 'workflow_evaluate',
      mediaItemId: null,
      circleId: workflow.circleId,
      reason: JobReason.rerun,
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

    const settings = await this.systemSettings.getSettings();
    const definition = workflow.definition as unknown as WorkflowDefinition;

    // Synthetic actor built from the creator's effective permissions; gate the
    // actions before committing a run row.
    const permissions = await this.loadUserPermissions(creatorUserId);
    const actor: RequestUser = {
      id: creatorUserId,
      email: '',
      roles: [],
      permissions,
      isActive: true,
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
        status: WorkflowRunStatus.evaluating,
        triggerType,
        definitionSnapshot: workflow.definition as Prisma.InputJsonValue,
        startedById: creatorUserId,
      },
    });

    await this.enrichmentJobs.enqueue({
      type: 'workflow_evaluate',
      mediaItemId: null,
      circleId: workflow.circleId,
      reason: JobReason.rerun,
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

    await this.circleMembership.assertCircleAccess(
      user.id,
      run.circleId,
      user.permissions,
      CircleRole.collaborator,
    );

    if (run.status !== WorkflowRunStatus.awaiting_approval) {
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
          status: WorkflowRunItemStatus.matched,
        },
        data: { status: WorkflowRunItemStatus.excluded },
      });
    }

    const remainingMatched = await this.prisma.workflowRunItem.count({
      where: { runId: run.id, status: WorkflowRunItemStatus.matched },
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
        status: WorkflowRunStatus.running,
        approvedById: user.id,
        approvedAt: now,
        startedAt: now,
      },
    });

    await this.enqueueExecuteBatches(updated, definition, settings);

    this.logTransition(updated, WorkflowRunStatus.running, 'run_approved', {
      actorUserId: user.id,
      remainingMatched,
    });
    await this.audit(user.id, 'workflow_run:approved', run.id, {
      remainingMatched,
      excluded: excluded.length,
    });

    return { runId: run.id, status: WorkflowRunStatus.running };
  }

  async cancelRun(
    runId: string,
    user: RequestUser,
  ): Promise<{ runId: string; status: WorkflowRunStatus }> {
    await this.assertFeatureEnabled();

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);

    await this.circleMembership.assertCircleAccess(
      user.id,
      run.circleId,
      user.permissions,
      CircleRole.collaborator,
    );

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException('Run already finished');
    }

    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: WorkflowRunStatus.cancelled, finishedAt: new Date() },
    });

    this.logTransition(run, WorkflowRunStatus.cancelled, 'run_cancelled', {
      actorUserId: user.id,
    });
    await this.audit(user.id, 'workflow_run:cancelled', run.id, {});

    return { runId: run.id, status: WorkflowRunStatus.cancelled };
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
      data: { status: WorkflowRunStatus.cancelled, finishedAt: new Date() },
    });

    this.logTransition(run, WorkflowRunStatus.cancelled, 'run_admin_cancelled', {
      actorUserId,
    });
    await this.audit(actorUserId, 'workflow_run:admin_cancelled', run.id, {});

    return { runId: run.id, status: WorkflowRunStatus.cancelled };
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
    await this.circleMembership.assertCircleAccess(
      user.id,
      workflow.circleId,
      user.permissions,
      CircleRole.viewer,
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
    await this.circleMembership.assertCircleAccess(
      user.id,
      run.circleId,
      user.permissions,
      CircleRole.viewer,
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
    query: { status?: WorkflowRunItemStatus; page: number; pageSize: number },
    user: RequestUser,
  ) {
    await this.assertFeatureEnabled();
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);
    await this.circleMembership.assertCircleAccess(
      user.id,
      run.circleId,
      user.permissions,
      CircleRole.viewer,
    );

    const { page, pageSize, status } = query;
    const where: Prisma.WorkflowRunItemWhereInput = { runId, ...(status ? { status } : {}) };

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
      where: { runId: run.id, status: WorkflowRunItemStatus.matched },
      select: { mediaItemId: true },
    });
    const ids = items.map((i) => i.mediaItemId);

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      await this.enrichmentJobs.enqueue({
        type: 'workflow_execute_batch',
        mediaItemId: null,
        circleId: run.circleId,
        reason: JobReason.rerun,
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
    triggerType: WorkflowTrigger = WorkflowTrigger.manual,
  ): boolean {
    if (triggerType !== WorkflowTrigger.manual) {
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
  private async loadUserPermissions(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            rolePermissions: { select: { permission: { select: { name: true } } } },
          },
        },
      },
    });
    const perms = new Set<string>();
    for (const ur of rows) {
      for (const rp of ur.role.rolePermissions) perms.add(rp.permission.name);
    }
    return [...perms];
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

      // move_to_circle: collaborator + systemPerms on BOTH source and target.
      if (perm.bothCircles) {
        const targetCircleId = action['targetCircleId'];
        if (typeof targetCircleId !== 'string' || !targetCircleId) {
          throw new BadRequestException('move_to_circle requires a targetCircleId');
        }
        await this.circleMembership.assertCircleAccess(
          user.id,
          circleId,
          user.permissions,
          CircleRole.collaborator,
        );
        await this.circleMembership.assertCircleAccess(
          user.id,
          targetCircleId,
          user.permissions,
          CircleRole.collaborator,
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
    const settings = await this.systemSettings.getSettings();
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
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
