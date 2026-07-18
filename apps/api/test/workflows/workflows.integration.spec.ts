/**
 * Media Workflow Automation — Phase 1 Integration (DB-gated, issue #139)
 *
 * NOTE: These tests use useMockDatabase: true (mocked Prisma via jest-mock-extended),
 * the same pattern as test/media/media-bulk-dashboard.integration.spec.ts. No live
 * PostgreSQL connection is required — they run in CI.
 *
 * Because Prisma is fully mocked, `mediaItem.findMany` does NOT apply the `where`
 * clause the way a real Postgres would — it returns whatever this file configures.
 * "Preview correctness" here therefore verifies two things a mocked DB CAN prove:
 *   1. WorkflowsService compiles the definition into the correct Prisma `where`
 *      shape and passes it to mediaItem.findMany (asserted directly on the mock's
 *      call args) — this is what the compiler unit tests exhaustively cover in
 *      isolation, exercised here end-to-end through the real HTTP + service stack.
 *   2. The service's own post-query logic (cap math, read-time refinement
 *      filtering, sample building, thumbnail attachment) is correct given a set
 *      of rows "as if" they already passed the where clause.
 * Real Postgres-level filtering correctness is out of scope without a live DB.
 */

import request from 'supertest';
import { randomUUID } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { MEDIA_ITEM_ACTIONS, MEDIA_ITEM_FIELDS } from '../../src/workflows/registry/media-item-fields';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_ID = '550e8400-e29b-41d4-a716-446655440099';
const OTHER_CIRCLE_ID = '550e8400-e29b-41d4-a716-446655440199';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors the setupCircleMocks helper in media-bulk-dashboard.integration.spec.ts. */
function setupCircleMocks(
  context: TestContext,
  userId: string,
  circleId: string,
  role: string,
): void {
  context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
  context.prismaMock.circleMember.findUnique.mockResolvedValue({
    circleId,
    userId,
    role,
    joinedAt: new Date(),
  });
}

/**
 * Enable features.workflows and populate the workflows.* settings block, busting
 * the SystemSettingsService's 5s in-process cache so the change is visible
 * immediately (same pattern as test/settings/system-settings.integration.spec.ts).
 */
function setupWorkflowsSettings(
  context: TestContext,
  workflowsOverrides: Record<string, unknown> = {},
): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: {
      ...DEFAULT_SYSTEM_SETTINGS,
      features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
      workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...workflowsOverrides },
    },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);

  const settingsService = context.module.get(SystemSettingsService);
  (settingsService as any).settingsCache = null;
}

/** Disable the feature (default state) — used to assert the 404 feature gate. */
function setupWorkflowsFeatureDisabled(context: TestContext): void {
  context.prismaMock.systemSettings.findUnique.mockResolvedValue({
    id: 'settings-1',
    key: 'global',
    value: { ...DEFAULT_SYSTEM_SETTINGS },
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
  } as any);
  const settingsService = context.module.get(SystemSettingsService);
  (settingsService as any).settingsCache = null;
}

function makeWorkflowRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    name: 'Screenshot cleanup',
    description: null,
    subjectType: 'media_item',
    enabled: true,
    trigger: 'manual',
    cronExpression: null,
    nextRunAt: null,
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [{ field: 'filename', op: 'contains', value: 'screenshot' }],
      actions: [{ type: 'move_to_trash' }],
    },
    createdById: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Fixture media item shaped like the preview select projection. metadata:null
 * avoids any storageObject lookup in MediaThumbnailService.attachThumbnailUrls. */
function makePreviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'photo',
    capturedAt: new Date('2024-06-01T12:00:00.000Z'),
    originalFilename: 'IMG_0001.jpg',
    width: 4000,
    height: 3000,
    metadata: null,
    ...overrides,
  };
}

const screenshotHeuristicDefinition = {
  version: 1,
  subject: 'media_item',
  match: 'any',
  conditions: [
    { field: 'filename', op: 'contains', value: 'screenshot' },
    {
      match: 'all',
      conditions: [
        { field: 'mimeType', op: 'equals', value: 'image/png' },
        { field: 'missingCamera', op: 'is', value: true },
        { field: 'missingCapturedAt', op: 'is', value: true },
      ],
    },
  ],
  actions: [{ type: 'move_to_trash' }],
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Workflows Integration (DB-gated)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
    // Default: feature enabled with stock settings. Individual tests override.
    setupWorkflowsSettings(context);
  });

  // =========================================================================
  // Feature gate
  // =========================================================================

  describe('feature gate', () => {
    it('returns 404 for POST /api/workflows when features.workflows is disabled', async () => {
      setupWorkflowsFeatureDisabled(context);
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'Test workflow',
          definition: screenshotHeuristicDefinition,
        })
        .expect(404);
    });
  });

  // =========================================================================
  // POST /api/workflows — CRUD + RBAC
  // =========================================================================

  describe('POST /api/workflows — RBAC', () => {
    it('returns 401 without a token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .send({ circleId: CIRCLE_ID, name: 'x', definition: screenshotHeuristicDefinition })
        .expect(401);
    });

    it('returns 403 for a viewer (lacks media:write)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(viewer.accessToken))
        .send({ circleId: CIRCLE_ID, name: 'x', definition: screenshotHeuristicDefinition })
        .expect(403);
    });

    it('returns 201 for a contributor with collaborator role in the circle', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      context.prismaMock.workflow.count.mockResolvedValue(0);
      context.prismaMock.workflow.create.mockImplementation(async ({ data }: any) =>
        makeWorkflowRow({ ...data, id: randomUUID() }),
      );

      const response = await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'Screenshot cleanup',
          definition: screenshotHeuristicDefinition,
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        circleId: CIRCLE_ID,
        name: 'Screenshot cleanup',
        subjectType: 'media_item',
        trigger: 'manual',
      });
      // dependencies derived from the definition: filename/mimeType/missingCamera/
      // missingCapturedAt are all `metadata` dependency fields.
      expect(response.body.data.dependencies).toEqual(['metadata']);
    });

    it('returns 403 when the contributor is not a member of the circle (cross-circle denied)', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID });
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null); // not a member

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'x',
          definition: screenshotHeuristicDefinition,
        })
        .expect(403);
    });

    it('returns 404 when the circle does not exist', async () => {
      const contributor = await createMockContributorUser(context);
      context.prismaMock.circle.findUnique.mockResolvedValue(null);
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: OTHER_CIRCLE_ID,
          name: 'x',
          definition: screenshotHeuristicDefinition,
        })
        .expect(404);
    });

    it('allows a super-admin (media:write_any) to bypass the per-circle membership check', async () => {
      const admin = await createMockAdminUser(context);
      // Deliberately leave circle/circleMember mocks unconfigured (no membership) —
      // the super-admin bypass must succeed without them.
      context.prismaMock.workflow.count.mockResolvedValue(0);
      context.prismaMock.workflow.create.mockImplementation(async ({ data }: any) =>
        makeWorkflowRow({ ...data, id: randomUUID() }),
      );

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(admin.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'Admin-created workflow',
          definition: screenshotHeuristicDefinition,
        })
        .expect(201);
    });

    it('returns 400 when the per-circle workflow cap is reached', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      // maxWorkflowsPerCircle default is 20.
      context.prismaMock.workflow.count.mockResolvedValue(20);

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'One too many',
          definition: screenshotHeuristicDefinition,
        })
        .expect(400);
    });

    it('returns 400 for an invalid definition (unknown field)', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'Bad def',
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'doesNotExist', op: 'equals', value: 'x' }],
            actions: [],
          },
        })
        .expect(400);
    });

    it('returns 400 when trigger is scheduled without a valid cronExpression', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      context.prismaMock.workflow.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .post('/api/workflows')
        .set(authHeader(contributor.accessToken))
        .send({
          circleId: CIRCLE_ID,
          name: 'Scheduled without cron',
          trigger: 'scheduled',
          definition: screenshotHeuristicDefinition,
        })
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/workflows — list, RBAC
  // =========================================================================

  describe('GET /api/workflows — RBAC', () => {
    it('returns 401 without a token', async () => {
      await request(context.app.getHttpServer())
        .get(`/api/workflows?circleId=${CIRCLE_ID}`)
        .expect(401);
    });

    it('returns 200 for a viewer with viewer role in the circle', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.workflow.findMany.mockResolvedValue([makeWorkflowRow()]);
      context.prismaMock.workflow.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get(`/api/workflows?circleId=${CIRCLE_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 1 });
    });

    it('returns 403 when the viewer is not a member of the circle', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID });
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/workflows?circleId=${CIRCLE_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });

  // =========================================================================
  // GET /api/workflows/:id
  // =========================================================================

  describe('GET /api/workflows/:id', () => {
    it('returns 200 for a viewer with circle access', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);

      const response = await request(context.app.getHttpServer())
        .get(`/api/workflows/${row.id}`)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(row.id);
    });

    it('returns 404 when the workflow does not exist', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.workflow.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`/api/workflows/${randomUUID()}`)
        .set(authHeader(viewer.accessToken))
        .expect(404);
    });
  });

  // =========================================================================
  // PATCH /api/workflows/:id — RBAC
  // =========================================================================

  describe('PATCH /api/workflows/:id — RBAC', () => {
    it('returns 403 for a viewer (lacks media:write)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/workflows/${randomUUID()}`)
        .set(authHeader(viewer.accessToken))
        .send({ name: 'Renamed' })
        .expect(403);
    });

    it('returns 200 for a contributor with collaborator role', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);
      context.prismaMock.workflow.update.mockImplementation(async ({ data }: any) => ({
        ...row,
        ...data,
        updatedAt: new Date(),
      }));

      const response = await request(context.app.getHttpServer())
        .patch(`/api/workflows/${row.id}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'Renamed workflow' })
        .expect(200);

      expect(response.body.data.name).toBe('Renamed workflow');
    });

    it('returns 403 for a contributor who is not a circle member (cross-circle denied)', async () => {
      const contributor = await createMockContributorUser(context);
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);
      context.prismaMock.circle.findUnique.mockResolvedValue({ id: row.circleId });
      context.prismaMock.circleMember.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .patch(`/api/workflows/${row.id}`)
        .set(authHeader(contributor.accessToken))
        .send({ name: 'Renamed' })
        .expect(403);
    });

    it('allows a super-admin to bypass the per-circle membership check', async () => {
      const admin = await createMockAdminUser(context);
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);
      context.prismaMock.workflow.update.mockImplementation(async ({ data }: any) => ({
        ...row,
        ...data,
        updatedAt: new Date(),
      }));

      await request(context.app.getHttpServer())
        .patch(`/api/workflows/${row.id}`)
        .set(authHeader(admin.accessToken))
        .send({ enabled: false })
        .expect(200);
    });
  });

  // =========================================================================
  // DELETE /api/workflows/:id — RBAC
  // =========================================================================

  describe('DELETE /api/workflows/:id — RBAC', () => {
    it('returns 403 for a viewer (lacks media:write)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .delete(`/api/workflows/${randomUUID()}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('returns 204 for a contributor with collaborator role', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'collaborator');
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);
      context.prismaMock.workflow.delete.mockResolvedValue(row);

      await request(context.app.getHttpServer())
        .delete(`/api/workflows/${row.id}`)
        .set(authHeader(contributor.accessToken))
        .expect(204);
    });

    it('returns 403 for a contributor who is only a viewer in the circle (rank too low)', async () => {
      const contributor = await createMockContributorUser(context);
      setupCircleMocks(context, contributor.id, CIRCLE_ID, 'viewer');
      const row = makeWorkflowRow();
      context.prismaMock.workflow.findUnique.mockResolvedValue(row);

      await request(context.app.getHttpServer())
        .delete(`/api/workflows/${row.id}`)
        .set(authHeader(contributor.accessToken))
        .expect(403);
    });
  });

  // =========================================================================
  // POST /api/workflows/preview
  // =========================================================================

  describe('POST /api/workflows/preview', () => {
    it('returns 200 for a viewer (preview only requires viewer role)', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([makePreviewRow()]);

      const response = await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({ circleId: CIRCLE_ID, definition: screenshotHeuristicDefinition })
        .expect(200);

      expect(response.body.data).toHaveProperty('matchedCount');
      expect(response.body.data).toHaveProperty('capped');
      expect(response.body.data).toHaveProperty('sample');
    });

    it('compiles the screenshot heuristic into the expected OR/AND where shape', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makePreviewRow(),
        makePreviewRow(),
      ]);

      await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({ circleId: CIRCLE_ID, definition: screenshotHeuristicDefinition })
        .expect(200);

      const calls = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const where = calls[0][0].where;
      expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
      expect(where.OR).toHaveLength(2);
      expect(where.OR[0]).toEqual({
        originalFilename: { contains: 'screenshot', mode: 'insensitive' },
      });
      expect(where.OR[1]).toEqual({
        AND: [
          { storageObject: { mimeType: 'image/png' } },
          { cameraMake: null, cameraModel: null },
          { capturedAt: null },
        ],
      });
    });

    it('compiles a pending-burst-group condition into the expected relation filter', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([makePreviewRow()]);

      await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({
          circleId: CIRCLE_ID,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'inPendingBurstGroup', op: 'is', value: true }],
            actions: [],
          },
        })
        .expect(200);

      const where = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.AND).toEqual([{ burstGroup: { is: { status: 'pending' } } }]);
    });

    it('compiles a pending-duplicate-group condition into the expected relation filter', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([makePreviewRow()]);

      await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({
          circleId: CIRCLE_ID,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'inPendingDuplicateGroup', op: 'is', value: true }],
            actions: [],
          },
        })
        .expect(200);

      const where = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.AND).toEqual([{ duplicateGroup: { is: { status: 'pending' } } }]);
    });

    it('compiles a pending-location-suggestion condition into the expected relation filter', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([makePreviewRow()]);

      await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({
          circleId: CIRCLE_ID,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'hasPendingLocationSuggestion', op: 'is', value: true }],
            actions: [],
          },
        })
        .expect(200);

      const where = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.AND).toEqual([{ locationSuggestion: { is: { status: 'pending' } } }]);
    });

    it('reports matchedCount equal to the number of returned rows when under the cap', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makePreviewRow(),
        makePreviewRow(),
        makePreviewRow(),
      ]);

      const response = await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({ circleId: CIRCLE_ID, definition: screenshotHeuristicDefinition })
        .expect(200);

      expect(response.body.data.matchedCount).toBe(3);
      expect(response.body.data.capped).toBe(false);
    });

    it('caps matchedCount and sets capped:true when rows exceed workflows.maxItemsPerRun', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      // Lower the cap so the test doesn't need to fabricate 10001 rows.
      setupWorkflowsSettings(context, { maxItemsPerRun: 5 });

      // cap + 1 rows returned by the probe query.
      const rows = Array.from({ length: 6 }, () => makePreviewRow());
      context.prismaMock.mediaItem.findMany.mockResolvedValue(rows);

      const response = await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({ circleId: CIRCLE_ID, definition: screenshotHeuristicDefinition })
        .expect(200);

      expect(response.body.data.matchedCount).toBe(5);
      expect(response.body.data.capped).toBe(true);

      // LIMIT (cap + 1) — the probe query's `take` argument.
      const probeCall = (context.prismaMock.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(probeCall.take).toBe(6);

      // Never a full COUNT(*) — the service uses only findMany, never .count(), for preview.
      expect(context.prismaMock.mediaItem.count).not.toHaveBeenCalled();
    });

    it('applies the orientationShape read-time refinement to the preview sample', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');
      // One portrait (600x800) and one landscape (800x600) row; only the
      // portrait one should survive the orientationShape:portrait refinement.
      context.prismaMock.mediaItem.findMany.mockResolvedValue([
        makePreviewRow({ id: 'portrait-1', width: 600, height: 800 }),
        makePreviewRow({ id: 'landscape-1', width: 800, height: 600 }),
      ]);

      const response = await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({
          circleId: CIRCLE_ID,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'orientationShape', op: 'equals', value: 'portrait' }],
            actions: [],
          },
        })
        .expect(200);

      expect(response.body.data.matchedCount).toBe(1);
      expect(response.body.data.sample).toHaveLength(1);
      expect(response.body.data.sample[0].id).toBe('portrait-1');
    });

    it('returns 400 for an invalid definition (unknown field)', async () => {
      const viewer = await createMockViewerUser(context);
      setupCircleMocks(context, viewer.id, CIRCLE_ID, 'viewer');

      await request(context.app.getHttpServer())
        .post('/api/workflows/preview')
        .set(authHeader(viewer.accessToken))
        .send({
          circleId: CIRCLE_ID,
          definition: {
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [{ field: 'doesNotExist', op: 'equals', value: 'x' }],
            actions: [],
          },
        })
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/workflows/subjects
  // =========================================================================

  describe('GET /api/workflows/subjects', () => {
    it('returns 401 without a token', async () => {
      await request(context.app.getHttpServer()).get('/api/workflows/subjects').expect(401);
    });

    it('returns a single media_item Subject with the full field + action catalogs', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/workflows/subjects')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      const { subjects } = response.body.data;
      expect(subjects).toHaveLength(1);
      expect(subjects[0].subject).toBe('media_item');
      expect(subjects[0].label).toBe('Media Item');
      expect(subjects[0].triggers).toEqual(['manual', 'on_media_enriched', 'scheduled']);
      expect(subjects[0].fields).toHaveLength(MEDIA_ITEM_FIELDS.length);
      expect(subjects[0].actions).toHaveLength(MEDIA_ITEM_ACTIONS.length);

      const filenameField = subjects[0].fields.find((f: any) => f.key === 'filename');
      expect(filenameField).toMatchObject({
        key: 'filename',
        label: 'Filename',
        group: 'File',
        type: 'string',
        operators: expect.arrayContaining(['contains', 'starts_with', 'ends_with', 'equals']),
      });

      const moveToTrash = subjects[0].actions.find((a: any) => a.type === 'move_to_trash');
      expect(moveToTrash).toEqual({ type: 'move_to_trash', label: 'Move to Trash' });

      const hardDelete = subjects[0].actions.find((a: any) => a.type === 'hard_delete');
      expect(hardDelete).toEqual({
        type: 'hard_delete',
        label: 'Delete permanently',
        destructive: true,
      });
    });

    it('does not require a circle context (no membership check)', async () => {
      const viewer = await createMockViewerUser(context);
      // Deliberately leave circle/circleMember mocks unconfigured.
      await request(context.app.getHttpServer())
        .get('/api/workflows/subjects')
        .set(authHeader(viewer.accessToken))
        .expect(200);
    });
  });
});
