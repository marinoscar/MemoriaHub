// =============================================================================
// The workflows slice on the real host (RETRO-J9, #622; retro-gaps audit)
// =============================================================================
//
// `workflow-runs.integration.spec.ts` drives the run lifecycle over a MOCKED Prisma client, so what it proves is
// the order of calls. This spec boots the whole application on real PostgreSQL and drives the slice's own
// services and job handlers over the real `workflows` / `workflow_runs` / `workflow_run_items` / `media_items` /
// `jobs` tables, with the real access, identity, settings and jobs port bindings:
//
//   - evaluate -> awaiting_approval -> approve (with an exclusion) -> execute_batch -> finalize, counters and the
//     media rows each step leaves behind;
//   - the `hard_delete` guards: the app-wide unlock, and the confirmation literal `DELETE {matchedCount}`;
//   - the node-run batch: `persistNodeResult` re-derives the item set from the TRUSTED `job.payload` and ignores
//     what the node submitted (a node that claims items outside the payload changes nothing).
//
// The application's Prisma client is the row-level-security bypass connection (the same ordinary role plus
// `app.rls_bypass`, see `rlsBypassPrisma`): MemoriaHub's domain services read the organization tables on the
// plain client until the app-read scoping release; seeding and every assertion use the org-scoped client.
//
// DB_GATED: reported as skipped (never passed) when no database is reachable.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';

import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '@marinoscar/memoriahub-api/ports';
import { OfflineGeoLocationProvider } from '@marinoscar/memoriahub-api/location';
import {
  WorkflowEvaluateHandler,
  WorkflowExecuteBatchHandler,
  WorkflowRunService,
} from '@marinoscar/memoriahub-api/workflows';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { dropLibraries, newLibrary } from '../helpers/library';
import { rlsBypassPrisma, seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const TRASH_DEFINITION = {
  version: 1,
  subject: 'media_item',
  match: 'all',
  conditions: [{ field: 'filename', op: 'contains', value: 'screenshot' }],
  actions: [{ type: 'move_to_trash' }],
};
const HARD_DELETE_DEFINITION = { ...TRASH_DEFINITION, actions: [{ type: 'hard_delete' }] };

describeMaybeDb('workflows slice on the real host (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let bypass: PrismaService;
  let seed: SeedClient;
  let moduleRef: TestingModule;
  let settings: MemoriahubSettingsPort;
  let runs: WorkflowRunService;
  let evaluate: WorkflowEvaluateHandler;
  let executeBatch: WorkflowExecuteBatchHandler;
  let orgId: string;
  let userId: string;
  let user: { id: string; roles: string[]; permissions: string[]; activeOrgId: null };
  const libraries: string[] = [];
  const objects: string[] = [];
  const workflowIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    bypass = await rlsBypassPrisma();
    orgId = (await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`)[0]!.id;

    // The contributor role holds media:write and media:delete; the user is also an admin member of the library.
    userId = (await prisma.user.create({ data: { email: `workflows-host-${randomUUID()}@example.test` } })).id;
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'contributor' }, include: { rolePermissions: { include: { permission: true } } } });
    await prisma.userRole.create({ data: { userId, roleId: role.id } });
    user = { id: userId, roles: ['contributor'], permissions: role.rolePermissions.map((rp) => rp.permission.name), activeOrgId: null };

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(bypass)
      .overrideProvider(OfflineGeoLocationProvider)
      .useValue({ onModuleInit: async () => undefined, reverseGeocode: async () => null })
      .compile();
    await moduleRef.init();

    settings = moduleRef.get(MEMORIAHUB_SETTINGS, { strict: false });
    runs = moduleRef.get(WorkflowRunService, { strict: false });
    evaluate = moduleRef.get(WorkflowEvaluateHandler, { strict: false });
    executeBatch = moduleRef.get(WorkflowExecuteBatchHandler, { strict: false });
    await settings.patchSystem('features', { workflows: true }, { actorUserId: userId });
    await settings.patchSystem('workflows', { allowHardDelete: false, requirePreview: true }, { actorUserId: userId });
  }, 120000);

  afterAll(async () => {
    try {
      await settings?.patchSystem('features', { workflows: false }, { actorUserId: userId });
      await settings?.patchSystem('workflows', { allowHardDelete: false }, { actorUserId: userId });
    } catch {
      /* best effort */
    }
    for (const libraryId of libraries) {
      await seed.workflowRun.deleteMany({ where: { circleId: libraryId } });
      await seed.workflow.deleteMany({ where: { circleId: libraryId } });
      await prisma.job.deleteMany({ where: { subjectId: libraryId } });
      await seed.mediaItem.deleteMany({ where: { circleId: libraryId } });
      await dropLibraries(prisma, [libraryId]);
    }
    if (objects.length > 0) await seed.storageObject.deleteMany({ where: { id: { in: objects } } });
    if (userId) {
      await prisma.userRole.deleteMany({ where: { userId } });
      await prisma.auditEvent.deleteMany({ where: { actorUserId: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await moduleRef?.close();
    await bypass?.$disconnect();
    await prisma?.$disconnect();
  });

  /** A library with `names.length` photos named as given, and one workflow over it. */
  async function seedScenario(names: string[], definition: object = TRASH_DEFINITION) {
    const library = await newLibrary(prisma, { ownerId: userId });
    libraries.push(library.id);
    const itemIds: string[] = [];
    for (const name of names) {
      const objectId = randomUUID();
      await seed.$executeRaw`
        INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
        VALUES (${objectId}::uuid, ${orgId}::uuid, ${name}, 1024, 'image/png', ${`uploads/${objectId}.png`}, 's3', 'ready', now())`;
      objects.push(objectId);
      const item = await seed.mediaItem.create({
        data: { storageObjectId: objectId, circleId: library.id, addedById: userId, type: 'photo', source: 'web', originalFilename: name },
        select: { id: true },
      });
      itemIds.push(item.id);
    }
    const workflow = await seed.workflow.create({
      data: {
        circleId: library.id,
        name: 'Screenshot cleanup',
        subjectType: 'media_item',
        enabled: true,
        trigger: 'manual',
        definition: definition as never,
        createdById: userId,
      },
      select: { id: true },
    });
    workflowIds.push(workflow.id);
    return { libraryId: library.id, workflowId: workflow.id, itemIds };
  }

  /** The newest queued job of a type for a library, as the worker would claim it. */
  async function queuedJob(type: string, libraryId: string) {
    const row = await prisma.job.findFirstOrThrow({ where: { type, subjectId: libraryId }, orderBy: { createdAt: 'desc' } });
    return { id: row.id, type: row.type, payload: row.payload, attempts: 1, subjectType: row.subjectType, subjectId: row.subjectId } as never;
  }

  const itemStates = async (ids: string[]) =>
    Object.fromEntries((await seed.mediaItem.findMany({ where: { id: { in: ids } }, select: { id: true, deletedAt: true } })).map((r) => [r.id, r.deletedAt !== null]));

  it('runs evaluate -> awaiting_approval -> approve with an exclusion -> execute_batch -> finalize, and the rows say so', async () => {
    const { libraryId, workflowId, itemIds } = await seedScenario(['screenshot-1.png', 'screenshot-2.png', 'screenshot-3.png', 'holiday.png']);
    const [s1, s2, s3, holiday] = itemIds as [string, string, string, string];

    const created = await runs.createRun(workflowId, {}, user);
    expect(created.status).toBe('evaluating');

    await evaluate.process(await queuedJob('workflow_evaluate', libraryId));
    const awaiting = await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } });
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.matchedCount).toBe(3);
    const matched = await seed.workflowRunItem.findMany({ where: { runId: created.runId } });
    expect(matched.map((i) => i.mediaItemId).sort()).toEqual([s1, s2, s3].sort());
    expect(matched.every((i) => i.status === 'matched')).toBe(true);
    // Nothing is touched while the run waits for a human.
    expect(await itemStates(itemIds)).toEqual({ [s1]: false, [s2]: false, [s3]: false, [holiday]: false });

    const approved = await runs.approveRun(created.runId, { excludedItemIds: [s3] }, user);
    expect(approved.status).toBe('running');
    expect((await seed.workflowRunItem.findMany({ where: { runId: created.runId, status: 'excluded' } })).map((i) => i.mediaItemId)).toEqual([s3]);

    const batch = await queuedJob('workflow_execute_batch', libraryId);
    expect(((batch as unknown as { payload: { itemIds: string[] } }).payload.itemIds).sort()).toEqual([s1, s2].sort());
    await executeBatch.process(batch);

    const finished = await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } });
    expect(finished.status).toBe('completed');
    expect(finished.finishedAt).not.toBeNull();
    expect([finished.processedCount, finished.succeededCount, finished.failedCount]).toEqual([2, 2, 0]);
    expect(await itemStates(itemIds)).toEqual({ [s1]: true, [s2]: true, [s3]: false, [holiday]: false });
    expect((await seed.workflowRunItem.findMany({ where: { runId: created.runId, status: 'applied' } })).map((i) => i.mediaItemId).sort()).toEqual([s1, s2].sort());
  });

  it('refuses a hard_delete run until the app-wide unlock is on, then demands the literal DELETE {matchedCount}', async () => {
    const { libraryId, workflowId } = await seedScenario(['screenshot-a.png', 'screenshot-b.png'], HARD_DELETE_DEFINITION);

    await expect(runs.createRun(workflowId, {}, user)).rejects.toThrow();
    expect(await seed.workflowRun.count({ where: { circleId: libraryId } })).toBe(0);

    await settings.patchSystem('workflows', { allowHardDelete: true }, { actorUserId: userId });
    const created = await runs.createRun(workflowId, {}, user);
    await evaluate.process(await queuedJob('workflow_evaluate', libraryId));
    expect((await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } })).matchedCount).toBe(2);

    const exclusion = (await seed.workflowRunItem.findFirstOrThrow({ where: { runId: created.runId } })).mediaItemId;
    for (const wrong of [undefined, '', 'DELETE', 'DELETE 1', 'delete 2', 'DELETE 2 ']) {
      // A refused approval must not exclude anything either (#735).
      await expect(
        runs.approveRun(created.runId, { excludedItemIds: [exclusion], ...(wrong === undefined ? {} : { confirmation: wrong }) }, user),
      ).rejects.toThrow(/Confirmation required/);
      expect((await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } })).status).toBe('awaiting_approval');
      expect(await seed.workflowRunItem.count({ where: { runId: created.runId, status: 'matched' } })).toBe(2);
    }
    expect(await prisma.job.count({ where: { type: 'workflow_execute_batch', subjectId: libraryId } })).toBe(0);

    const approved = await runs.approveRun(created.runId, { confirmation: 'DELETE 2' }, user);
    expect(approved.status).toBe('running');
    expect(await prisma.job.count({ where: { type: 'workflow_execute_batch', subjectId: libraryId } })).toBeGreaterThan(0);
    expect(await prisma.auditEvent.count({ where: { actorUserId: userId, action: 'workflow_run:hard_delete_approved', targetId: created.runId } })).toBe(1);

    await settings.patchSystem('workflows', { allowHardDelete: false }, { actorUserId: userId });
  });

  it('persistNodeResult re-derives the items from job.payload and ignores what the node submitted', async () => {
    const { libraryId, workflowId, itemIds } = await seedScenario(['screenshot-n1.png', 'screenshot-n2.png', 'screenshot-n3.png']);
    const [n1, n2, n3] = itemIds as [string, string, string];

    const created = await runs.createRun(workflowId, {}, user);
    await evaluate.process(await queuedJob('workflow_evaluate', libraryId));
    await runs.approveRun(created.runId, { excludedItemIds: [n3] }, user);
    const batch = (await queuedJob('workflow_execute_batch', libraryId)) as unknown as {
      id: string; type: string; payload: { runId: string; itemIds: string[] };
    };
    expect(batch.payload.itemIds.sort()).toEqual([n1, n2].sort());

    // The node claims an item OUTSIDE the trusted payload (n3, excluded by the human) and invents an outcome
    // for an id that is not in the run at all; it also says nothing about n1 and n2.
    const lyingResult = {
      runId: created.runId,
      items: [
        { mediaItemId: n3, actionResults: [{ type: 'move_to_trash', status: 'applied' }] },
        { mediaItemId: randomUUID(), actionResults: [{ type: 'hard_delete', status: 'applied' }] },
      ],
    };
    await executeBatch.persistNodeResult(batch as never, lyingResult);

    expect(await itemStates(itemIds)).toEqual({ [n1]: true, [n2]: true, [n3]: false });
    const finished = await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } });
    expect(finished.status).toBe('completed');
    expect([finished.processedCount, finished.succeededCount]).toEqual([2, 2]);
    const rows = await seed.workflowRunItem.findMany({ where: { runId: created.runId } });
    expect(rows.find((r) => r.mediaItemId === n3)!.status).toBe('excluded');
    expect(rows.filter((r) => r.status === 'applied').map((r) => r.mediaItemId).sort()).toEqual([n1, n2].sort());

    // Submitting the same result again is idempotent: nothing is applied twice.
    await executeBatch.persistNodeResult(batch as never, lyingResult);
    const again = await seed.workflowRun.findUniqueOrThrow({ where: { id: created.runId } });
    expect([again.status, again.processedCount, again.succeededCount]).toEqual(['completed', 2, 2]);
  });
});
