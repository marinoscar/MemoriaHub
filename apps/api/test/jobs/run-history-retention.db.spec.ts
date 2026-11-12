/**
 * The run-history retention purges against real PostgreSQL (RETRO-C7, #604).
 *
 * A mocked Prisma cannot prove the where-clauses the purges build (status lists, the
 * `finishedAt`-or-`updatedAt` fallback, the cascade to run items) or that the
 * `canDelete` veto reads a real run row, so this tier runs the two retention handlers
 * and one execute-batch veto over a migrated database.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`). Skips
 * (reported as skipped, never passed) when nothing listens on the port.
 */
import { dropLibraries, newLibrary } from '../helpers/library';
import { Logger } from '@nestjs/common';
import type { Job, JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../src/prisma/prisma.service';
import { ReviewRunsRetentionHandler } from '../../src/review-runs/review-runs-retention.handler';
import { WorkflowExecuteBatchHandler } from '@marinoscar/memoriahub-api/workflows';
import { WorkflowRunsRetentionHandler } from '../../src/workflows/runs/workflow-runs-retention.handler';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describeMaybeDb('Run-history retention purges (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let seed: SeedClient;
  let userId: string;
  let circleId: string;
  let workflowId: string;
  const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;
  const policy = { workflowRuns: { enabled: true, days: 30 }, reviewRuns: { enabled: true, days: 30 } };
  const settings = {
    getSettings: async () => ({ workflows: { previewTtlHours: 24 } }),
    getRetentionPolicy: async () => policy,
  };
  const job = { id: 'retention-db-spec' } as Job;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    const user = await prisma.user.create({ data: { email: `retention-${Date.now()}@example.test` } });
    userId = user.id;
    circleId = (await newLibrary(prisma, { ownerId: userId, name: 'Circle Alpha' })).id;
    const workflow = await seed.workflow.create({
      data: { circleId, name: 'Workflow A', subjectType: 'media_item', trigger: 'manual', definition: {} },
    });
    workflowId = workflow.id;
  });

  afterAll(async () => {
    // No circle cascade any more (RETRO-K2): the library's rows go first.
    await seed.reviewRun.deleteMany({ where: { circleId } });
    await seed.trashEmptyRun.deleteMany({ where: { circleId } });
    await seed.workflow.deleteMany({ where: { circleId } });
    await dropLibraries(prisma, [circleId]);
    await prisma.user.deleteMany({ where: { id: userId } });
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  const workflowRun = (status: string, updatedAt: Date, finishedAt: Date | null) =>
    seed.workflowRun.create({
      data: {
        workflowId,
        circleId,
        status: status as never,
        triggerType: 'manual',
        definitionSnapshot: {},
        updatedAt,
        finishedAt,
      },
    });

  it('workflowRuns: expires a stale approval, deletes only terminal runs past the window', async () => {
    const approval = await workflowRun('awaiting_approval', ago(2), null);
    const old = await workflowRun('completed', ago(40), ago(40));
    const oldNoFinish = await workflowRun('cancelled', ago(40), null);
    const recent = await workflowRun('completed', ago(10), ago(10));
    const running = await workflowRun('running', ago(40), null);

    await new WorkflowRunsRetentionHandler(registry, prisma, settings as never).process(job);

    const left = await seed.workflowRun.findMany({ where: { workflowId }, select: { id: true, status: true } });
    const byId = new Map(left.map((r) => [r.id, r.status]));
    expect(byId.get(approval.id)).toBe('expired');
    expect(byId.has(old.id)).toBe(false);
    expect(byId.has(oldNoFinish.id)).toBe(false);
    expect(byId.get(recent.id)).toBe('completed');
    expect(byId.get(running.id)).toBe('running');
  });

  it('canDelete reads the real run: a pending batch of a running run is vetoed', async () => {
    const run = await workflowRun('running', new Date(), null);
    const handler = new WorkflowExecuteBatchHandler({} as never, prisma as never, {} as never, {} as never, {} as never);
    const pending = { status: 'pending', payload: { runId: run.id, itemIds: [] } } as unknown as Job;
    expect(await handler.canDelete(pending)).toContain('Cancel the run');
    await seed.workflowRun.update({ where: { id: run.id }, data: { status: 'cancelled' } });
    expect(await handler.canDelete(pending)).toBeNull();
  });

  it('reviewRuns: fails stuck runs and purges old review and empty-trash runs', async () => {
    const review = (status: string, updatedAt: Date, finishedAt: Date | null) =>
      seed.reviewRun.create({
        data: { circleId, subjectType: 'burst_group', action: 'dismiss', threshold: 50, status: status as never, updatedAt, finishedAt },
      });
    const trash = (status: string, updatedAt: Date, finishedAt: Date | null) =>
      seed.trashEmptyRun.create({ data: { circleId, status: status as never, updatedAt, finishedAt } });

    const stale = await review('evaluating', ago(2), null);
    const oldReview = await review('failed', ago(40), ago(40));
    const recentReview = await review('completed', ago(1), ago(1));
    const staleTrash = await trash('running', ago(3), null);
    const oldTrash = await trash('completed', ago(31), ago(31));

    await new ReviewRunsRetentionHandler(registry, prisma, settings as never).process(job);

    const reviews = new Map(
      (await seed.reviewRun.findMany({ where: { circleId } })).map((r) => [r.id, r]),
    );
    const trashes = new Map(
      (await seed.trashEmptyRun.findMany({ where: { circleId } })).map((r) => [r.id, r]),
    );
    expect(reviews.get(stale.id)?.status).toBe('failed');
    expect(reviews.get(stale.id)?.lastError).toMatch(/stale/);
    expect(reviews.has(oldReview.id)).toBe(false);
    expect(reviews.has(recentReview.id)).toBe(true);
    expect(trashes.get(staleTrash.id)?.status).toBe('failed');
    expect(trashes.has(oldTrash.id)).toBe(false);
  });
});
