/**
 * Unit tests for WorkflowsService — action/trigger compatibility guard
 * (issue #140, commit 46e2876b "enforce hard_delete manual-only at definition
 * validation").
 *
 * Scope: `assertActionsAllowedForTrigger` is exercised end-to-end through
 * `createWorkflow` / `updateWorkflow` (it is private, no direct unit surface).
 * Full CRUD/RBAC/preview behavior for WorkflowsService is already covered by
 * `test/workflows/workflows.integration.spec.ts` (Phase 1) — this spec adds
 * the one guard that integration suite does not exercise: hard_delete (the
 * only `triggerCompatibility: 'manual_only'` action in the registry) being
 * rejected on a non-manual trigger, and allowed on every trigger otherwise.
 *
 * No database required — PrismaService and the settings/circle services are
 * mocked; WorkflowDefinitionValidator and WorkflowConditionCompiler are real
 * (pure, no I/O) instances, same precedent as the Phase 1 integration spec
 * exercising the real compiler through the HTTP layer.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WorkflowsService } from './workflows.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const USER_ID = randomUUID();
const WORKFLOW_ID = randomUUID();

function makeUser(): RequestUser {
  return {
    id: USER_ID,
    email: 'user@example.com',
    roles: ['Contributor'],
    permissions: ['media:write'],
    isActive: true,
  };
}

function defWithActions(actions: Array<Record<string, unknown>>) {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions,
  };
}

function makeWorkflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    circleId: CIRCLE_ID,
    name: 'Existing',
    description: null,
    subjectType: 'media_item',
    enabled: true,
    trigger: 'manual',
    cronExpression: null,
    nextRunAt: null,
    definition: defWithActions([{ type: 'move_to_trash' }]),
    createdById: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WorkflowsService — hard_delete trigger-compat guard', () => {
  let service: WorkflowsService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>> = {
      getSettings: jest.fn().mockResolvedValue({
        ...DEFAULT_SYSTEM_SETTINGS,
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
      }),
    };
    const circleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>> = {
      assertCircleAccess: jest
        .fn()
        .mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    const thumbnails: jest.Mocked<Pick<MediaThumbnailService, 'attachThumbnailUrls'>> = {
      attachThumbnailUrls: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowsService,
        WorkflowDefinitionValidator,
        WorkflowConditionCompiler,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: CircleMembershipService, useValue: circleMembership },
        { provide: MediaThumbnailService, useValue: thumbnails },
      ],
    }).compile();

    service = module.get(WorkflowsService);

    prisma.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID } as any);
    prisma.circleMember.findUnique.mockResolvedValue({
      circleId: CIRCLE_ID,
      userId: USER_ID,
      role: 'collaborator',
      joinedAt: new Date(),
    } as any);
    prisma.workflow.count.mockResolvedValue(0);
    (prisma.workflow.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      ...makeWorkflowRow(),
      ...data,
      id: randomUUID(),
    }));
  });

  describe('createWorkflow', () => {
    it('rejects hard_delete on trigger "on_media_enriched"', async () => {
      await expect(
        service.createWorkflow(
          {
            circleId: CIRCLE_ID,
            name: 'Auto-purge',
            trigger: 'on_media_enriched',
            definition: defWithActions([{ type: 'hard_delete' }]),
          } as any,
          makeUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects hard_delete on trigger "scheduled"', async () => {
      await expect(
        service.createWorkflow(
          {
            circleId: CIRCLE_ID,
            name: 'Scheduled purge',
            trigger: 'scheduled',
            cronExpression: '0 3 * * *',
            definition: defWithActions([{ type: 'hard_delete' }]),
          } as any,
          makeUser(),
        ),
      ).rejects.toThrow(/only allowed on manual-trigger workflows/);
    });

    it('allows hard_delete on trigger "manual"', async () => {
      const result = await service.createWorkflow(
        {
          circleId: CIRCLE_ID,
          name: 'Manual purge',
          trigger: 'manual',
          definition: defWithActions([{ type: 'hard_delete' }]),
        } as any,
        makeUser(),
      );
      expect(result.trigger).toBe('manual');
    });

    it.each([
      'move_to_trash',
      'archive',
      'unarchive',
      'add_tags',
      'remove_tags',
      'set_favorite',
      'resolve_burst_group',
      'dismiss_burst_group',
      'resolve_duplicate_group',
      'dismiss_duplicate_group',
      'accept_location_suggestion',
      'reject_location_suggestion',
    ])('allows non-manual-only action "%s" on trigger "on_media_enriched"', async (type) => {
      const params =
        type === 'add_tags' || type === 'remove_tags'
          ? { names: ['x'] }
          : type === 'set_favorite'
            ? { value: true }
            : type === 'resolve_burst_group' || type === 'resolve_duplicate_group'
              ? { action: 'archive' }
              : {};

      await expect(
        service.createWorkflow(
          {
            circleId: CIRCLE_ID,
            name: `Auto ${type}`,
            trigger: 'on_media_enriched',
            definition: defWithActions([{ type, ...params }]),
          } as any,
          makeUser(),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('updateWorkflow', () => {
    it('rejects switching an existing hard_delete workflow to a scheduled trigger', async () => {
      const row = makeWorkflowRow({
        trigger: 'manual',
        definition: defWithActions([{ type: 'hard_delete' }]),
      });
      prisma.workflow.findUnique.mockResolvedValue(row as any);

      await expect(
        service.updateWorkflow(
          WORKFLOW_ID,
          { trigger: 'scheduled', cronExpression: '0 3 * * *' } as any,
          makeUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects adding hard_delete to a definition on an already-scheduled workflow', async () => {
      const row = makeWorkflowRow({
        trigger: 'scheduled',
        cronExpression: '0 3 * * *',
        definition: defWithActions([{ type: 'move_to_trash' }]),
      });
      prisma.workflow.findUnique.mockResolvedValue(row as any);

      await expect(
        service.updateWorkflow(
          WORKFLOW_ID,
          { definition: defWithActions([{ type: 'hard_delete' }]) } as any,
          makeUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows switching trigger to manual on a workflow that already has hard_delete', async () => {
      const row = makeWorkflowRow({
        trigger: 'on_media_enriched',
        definition: defWithActions([{ type: 'move_to_trash' }]), // not manual-only itself
      });
      prisma.workflow.findUnique.mockResolvedValue(row as any);
      (prisma.workflow.update as jest.Mock).mockImplementation(async ({ data }: any) => ({
        ...row,
        ...data,
      }));

      await expect(
        service.updateWorkflow(WORKFLOW_ID, { trigger: 'manual' } as any, makeUser()),
      ).resolves.toBeDefined();
    });
  });
});
