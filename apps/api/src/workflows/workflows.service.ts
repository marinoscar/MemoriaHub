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
import { getFullRegistry } from './registry/subject-registry';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { PreviewWorkflowDto } from './dto/preview-workflow.dto';
import { isValidCron } from './util/cron.util';

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
    const cronExpression = this.resolveCron(trigger, dto.cronExpression ?? null);

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
    await this.assertFeatureEnabled();
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

    if (dto.definition !== undefined) {
      const definition = this.validator.validate(dto.definition);
      data.definition = definition as unknown as Prisma.InputJsonValue;
      data.subjectType = definition.subject as WorkflowSubject;
    }

    // Resolve the trigger/cron pair after applying any partial change, then
    // validate it as a whole (cron required iff scheduled).
    const resultingTrigger = (dto.trigger ?? existing.trigger) as WorkflowTrigger;
    const resultingCronInput =
      dto.cronExpression !== undefined ? dto.cronExpression : existing.cronExpression;
    const cronExpression = this.resolveCron(resultingTrigger, resultingCronInput);
    if (dto.trigger !== undefined) data.trigger = resultingTrigger;
    if (dto.trigger !== undefined || dto.cronExpression !== undefined) {
      data.cronExpression = cronExpression;
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

  private async findWorkflowOrThrow(id: string): Promise<Workflow> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    if (!workflow) {
      throw new NotFoundException(`Workflow ${id} not found`);
    }
    return workflow;
  }

  /**
   * Resolve the cron column for a trigger: required + valid for `scheduled`,
   * forced null otherwise.
   */
  private resolveCron(trigger: WorkflowTrigger, cron: string | null): string | null {
    if (trigger === 'scheduled') {
      if (!cron || !isValidCron(cron)) {
        throw new BadRequestException(
          'cronExpression is required and must be a valid 5-field cron when trigger is scheduled',
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
