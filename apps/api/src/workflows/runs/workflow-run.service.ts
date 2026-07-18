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
  WorkflowRun,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
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

    await this.audit(user.id, 'workflow_run:started', run.id, {
      workflowId: workflow.id,
      circleId: workflow.circleId,
    });

    return { runId: run.id, status: run.status };
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

    await this.audit(user.id, 'workflow_run:cancelled', run.id, {});

    return { runId: run.id, status: WorkflowRunStatus.cancelled };
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
   * Approval-bypass rule: a run may skip `awaiting_approval` and execute
   * immediately IFF the per-workflow AND system `requirePreview` are BOTH
   * explicitly false AND the definition contains NO gated action. Permission
   * gating already ran at createRun, so this is intentionally gating-free.
   */
  shouldBypassApproval(definition: WorkflowDefinition, settings: ResolvedSettings): boolean {
    if (definition.options?.requirePreview !== false) return false;
    if ((settings.workflows?.requirePreview ?? true) !== false) return false;

    for (const rawAction of definition.actions) {
      const action = rawAction as Record<string, unknown>;
      const descriptor = getActionDescriptor(definition.subject, String(action['type']));
      if (descriptor && this.isGatedAction(descriptor, action)) return false;
    }
    return true;
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
