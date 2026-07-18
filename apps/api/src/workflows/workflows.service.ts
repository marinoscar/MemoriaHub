import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Workflow, WorkflowSubject, WorkflowTrigger } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { isWorkflowsEnabled } from '../common/types/settings.types';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator';
import { WorkflowDefinition } from './definition/workflow-definition.schema';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler';
import { getActionDescriptor, getFullRegistry } from './registry/subject-registry';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { PreviewWorkflowDto } from './dto/preview-workflow.dto';
import { cronMinIntervalMinutes, isValidCron, nextCronDate } from './util/cron.util';

/** Fallback minimum schedule interval (minutes) when the setting is absent. */
const DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES = 60;

/** Max sample items returned by the preview. */
const PREVIEW_SAMPLE_SIZE = 12;

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly circleMembership: CircleMembershipService,
    private readonly thumbnails: MediaThumbnailService,
    private readonly validator: WorkflowDefinitionValidator,
    private readonly compiler: WorkflowConditionCompiler,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async createWorkflow(dto: CreateWorkflowDto, user: RequestUser) {
    const settings = await this.assertFeatureEnabled();
    await this.circleMembership.assertCircleAccess(
      user.id,
      dto.circleId,
      user.permissions,
      'collaborator',
    );

    // Registry-aware validation (subject + fields/ops/values + action types).
    const definition = this.validator.validate(dto.definition);
    const trigger = (dto.trigger ?? 'manual') as WorkflowTrigger;
    // Reject manual-only actions (hard_delete) on an automatic trigger.
    this.assertActionsAllowedForTrigger(definition, trigger);
    const minInterval =
      settings.workflows?.scheduleMinIntervalMinutes ?? DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES;
    const cronExpression = this.resolveCron(trigger, dto.cronExpression ?? null, minInterval);
    // Scheduled workflows are made due immediately on their next cron fire; the
    // Phase-4 scheduler cron then advances nextRunAt after each tick.
    const nextRunAt =
      trigger === 'scheduled' ? nextCronDate(cronExpression as string, new Date()) : null;

    // Enforce the per-circle workflow cap.
    const max = settings.workflows?.maxWorkflowsPerCircle ?? 20;
    const existingCount = await this.prisma.workflow.count({
      where: { circleId: dto.circleId },
    });
    if (existingCount >= max) {
      throw new BadRequestException(
        `Circle has reached the maximum of ${max} workflows`,
      );
    }

    const workflow = await this.prisma.workflow.create({
      data: {
        circleId: dto.circleId,
        name: dto.name,
        description: dto.description ?? null,
        subjectType: definition.subject as WorkflowSubject,
        enabled: dto.enabled ?? true,
        trigger,
        cronExpression,
        nextRunAt,
        definition: definition as unknown as Prisma.InputJsonValue,
        createdById: user.id,
      },
    });

    await this.audit(user.id, 'workflow:created', workflow.id, {
      circleId: workflow.circleId,
      name: workflow.name,
    });

    return this.serialize(workflow);
  }

  async listWorkflows(query: ListWorkflowsQueryDto, user: RequestUser) {
    await this.assertFeatureEnabled();
    await this.circleMembership.assertCircleAccess(
      user.id,
      query.circleId,
      user.permissions,
      'viewer',
    );

    const { page, pageSize } = query;
    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.workflow.findMany({
        where: { circleId: query.circleId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.workflow.count({ where: { circleId: query.circleId } }),
    ]);

    return {
      items: items.map((w) => this.serialize(w)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async getWorkflow(id: string, user: RequestUser) {
    await this.assertFeatureEnabled();
    const workflow = await this.findWorkflowOrThrow(id);
    await this.circleMembership.assertCircleAccess(
      user.id,
      workflow.circleId,
      user.permissions,
      'viewer',
    );
    return this.serialize(workflow);
  }

  async updateWorkflow(id: string, dto: UpdateWorkflowDto, user: RequestUser) {
    const settings = await this.assertFeatureEnabled();
    const existing = await this.findWorkflowOrThrow(id);
    await this.circleMembership.assertCircleAccess(
      user.id,
      existing.circleId,
      user.permissions,
      'collaborator',
    );

    const data: Prisma.WorkflowUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    let validatedDefinition: WorkflowDefinition | undefined;
    if (dto.definition !== undefined) {
      validatedDefinition = this.validator.validate(dto.definition);
      data.definition = validatedDefinition as unknown as Prisma.InputJsonValue;
      data.subjectType = validatedDefinition.subject as WorkflowSubject;
    }

    // Resolve the trigger/cron pair after applying any partial change, then
    // validate it as a whole (cron required iff scheduled).
    const resultingTrigger = (dto.trigger ?? existing.trigger) as WorkflowTrigger;
    const resultingCronInput =
      dto.cronExpression !== undefined ? dto.cronExpression : existing.cronExpression;
    const minInterval =
      settings.workflows?.scheduleMinIntervalMinutes ?? DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES;
    const cronExpression = this.resolveCron(resultingTrigger, resultingCronInput, minInterval);

    // Re-check trigger/action compatibility against the resulting (post-patch)
    // definition + trigger — either side may have changed in this update.
    const effectiveDefinition =
      validatedDefinition ?? (existing.definition as unknown as WorkflowDefinition);
    this.assertActionsAllowedForTrigger(effectiveDefinition, resultingTrigger);
    if (dto.trigger !== undefined) data.trigger = resultingTrigger;
    if (dto.trigger !== undefined || dto.cronExpression !== undefined) {
      data.cronExpression = cronExpression;
    }

    // Maintain nextRunAt: clear it whenever the resulting trigger is not
    // scheduled; (re)compute it when the workflow becomes/stays scheduled AND
    // either the trigger or the cron changed. An unchanged scheduled workflow
    // keeps its existing nextRunAt untouched.
    if (resultingTrigger !== 'scheduled') {
      data.nextRunAt = null;
    } else {
      const triggerChanged = resultingTrigger !== existing.trigger;
      const cronChanged = cronExpression !== existing.cronExpression;
      if (triggerChanged || cronChanged) {
        data.nextRunAt = nextCronDate(cronExpression as string, new Date());
      }
    }

    const workflow = await this.prisma.workflow.update({ where: { id }, data });

    await this.audit(user.id, 'workflow:updated', workflow.id, {
      circleId: workflow.circleId,
    });

    return this.serialize(workflow);
  }

  async deleteWorkflow(id: string, user: RequestUser): Promise<void> {
    await this.assertFeatureEnabled();
    const existing = await this.findWorkflowOrThrow(id);
    await this.circleMembership.assertCircleAccess(
      user.id,
      existing.circleId,
      user.permissions,
      'collaborator',
    );

    // DB cascade removes runs + run items.
    await this.prisma.workflow.delete({ where: { id } });
    await this.audit(user.id, 'workflow:deleted', id, {
      circleId: existing.circleId,
    });
  }

  // ---------------------------------------------------------------------------
  // Preview (stateless)
  // ---------------------------------------------------------------------------

  async preview(dto: PreviewWorkflowDto, user: RequestUser) {
    const settings = await this.assertFeatureEnabled();
    await this.circleMembership.assertCircleAccess(
      user.id,
      dto.circleId,
      user.permissions,
      'viewer',
    );

    const definition = this.validator.validate(dto.definition);
    const compiled = this.compiler.compile(dto.circleId, definition);

    // Cap the count probe: LIMIT (min(definition.options.maxItems, maxItemsPerRun) + 1).
    const maxItemsPerRun = settings.workflows?.maxItemsPerRun ?? 10000;
    const defMax = definition.options?.maxItems;
    const cap = defMax !== undefined ? Math.min(defMax, maxItemsPerRun) : maxItemsPerRun;

    const orderBy: Prisma.MediaItemOrderByWithRelationInput[] = [
      { capturedAt: 'desc' },
      { id: 'desc' },
    ];

    // Count probe — id (+ any refinement columns) only, hard-capped at cap+1.
    const needRefine = compiled.refinements.length > 0;
    const countSelect: Prisma.MediaItemSelect = { id: true };
    if (needRefine) {
      for (const r of compiled.refinements) Object.assign(countSelect, r.select);
    }
    const probe = await this.prisma.mediaItem.findMany({
      where: compiled.where,
      orderBy,
      take: cap + 1,
      select: countSelect,
    });
    const matchedRows = needRefine
      ? probe.filter((row) => compiled.refinements.every((r) => r.predicate(row)))
      : probe;
    const capped = probe.length > cap;
    const matchedCount = Math.min(matchedRows.length, cap);

    // Sample — top N by the gallery keyset ordering, with signed thumbnails.
    const sampleRows = await this.prisma.mediaItem.findMany({
      where: compiled.where,
      orderBy,
      take: needRefine ? cap + 1 : PREVIEW_SAMPLE_SIZE,
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
    const filteredSample = (
      needRefine
        ? sampleRows.filter((row) => compiled.refinements.every((r) => r.predicate(row)))
        : sampleRows
    ).slice(0, PREVIEW_SAMPLE_SIZE);

    const signed = await this.thumbnails.attachThumbnailUrls(filteredSample);
    const sample = signed.map((item) => ({
      id: item.id,
      type: item.type,
      capturedAt: item.capturedAt,
      filename: item.originalFilename,
      width: item.width,
      height: item.height,
      thumbnailUrl: item.thumbnailUrl,
    }));

    return { matchedCount, capped, sample };
  }

  // ---------------------------------------------------------------------------
  // Subjects registry
  // ---------------------------------------------------------------------------

  async getSubjects() {
    await this.assertFeatureEnabled();
    return {
      subjects: getFullRegistry().map((entry) => ({
        subject: entry.subject,
        label: entry.label,
        triggers: entry.triggers,
        fields: entry.fields.map((f) => ({
          key: f.key,
          label: f.label,
          group: f.group,
          type: f.type,
          operators: f.operators,
          valueType: f.valueType,
          ...(f.enumValues ? { enumValues: f.enumValues } : {}),
          dependency: f.dependency,
          ...(f.readTimeRefinement ? { readTimeRefinement: true } : {}),
        })),
        actions: entry.actions.map((a) => ({
          type: a.type,
          label: a.label,
          ...(a.destructive ? { destructive: true } : {}),
        })),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Feature gate: 404 when the Workflows feature is disabled. */
  private async assertFeatureEnabled() {
    const settings = await this.systemSettings.getSettings();
    if (!isWorkflowsEnabled(settings)) {
      throw new NotFoundException('Workflows feature is not enabled');
    }
    return settings;
  }

  /**
   * Enforce action/trigger compatibility: an action whose descriptor is
   * `triggerCompatibility: 'manual_only'` (currently only `hard_delete`) may not
   * be attached to a non-manual (on_media_enriched / scheduled) workflow. All
   * other actions are allowed on every trigger.
   */
  private assertActionsAllowedForTrigger(
    definition: WorkflowDefinition,
    trigger: WorkflowTrigger,
  ): void {
    if (trigger === 'manual') return;
    for (const action of definition.actions) {
      const descriptor = getActionDescriptor(definition.subject, action.type);
      if (descriptor?.triggerCompatibility === 'manual_only') {
        throw new BadRequestException(
          `Action "${action.type}" is only allowed on manual-trigger workflows`,
        );
      }
    }
  }

  private async findWorkflowOrThrow(id: string): Promise<Workflow> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    if (!workflow) {
      throw new NotFoundException(`Workflow ${id} not found`);
    }
    return workflow;
  }

  /**
   * Resolve the cron column for a trigger: required + valid for `scheduled`,
   * forced null otherwise. For a scheduled workflow the cron's minimum fire
   * interval must also be at least `minIntervalMinutes` (the
   * `workflows.scheduleMinIntervalMinutes` setting) — a denser schedule is
   * rejected with 400.
   */
  private resolveCron(
    trigger: WorkflowTrigger,
    cron: string | null,
    minIntervalMinutes: number,
  ): string | null {
    if (trigger === 'scheduled') {
      if (!cron || !isValidCron(cron)) {
        throw new BadRequestException(
          'cronExpression is required and must be a valid 5-field cron when trigger is scheduled',
        );
      }
      if (cronMinIntervalMinutes(cron) < minIntervalMinutes) {
        throw new BadRequestException(
          `Schedule interval must be at least ${minIntervalMinutes} minutes`,
        );
      }
      return cron;
    }
    return null;
  }

  /** Attach the derived dependency set to a workflow row for the API response. */
  private serialize(workflow: Workflow) {
    let dependencies: string[] = [];
    try {
      const def = workflow.definition as unknown as WorkflowDefinition;
      dependencies = this.compiler.deriveDependencies(def);
    } catch {
      dependencies = [];
    }
    return {
      id: workflow.id,
      circleId: workflow.circleId,
      name: workflow.name,
      description: workflow.description,
      subjectType: workflow.subjectType,
      enabled: workflow.enabled,
      trigger: workflow.trigger,
      cronExpression: workflow.cronExpression,
      nextRunAt: workflow.nextRunAt,
      definition: workflow.definition,
      dependencies,
      createdById: workflow.createdById,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
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
        targetType: 'workflow',
        targetId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
