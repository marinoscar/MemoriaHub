// DB_GATED: requires a real PostgreSQL database with migrations applied.
// Reachability is probed synchronously at module load via `describeMaybeDb`
// (test/helpers/db-probe.helper.ts), so the suite reports SKIPPED — never
// PASSED — where no database is available (e.g. CI, see
// docs/ci-known-failing-tests.md).
//
// Purpose (issue #302): drive MemoriesGenerationTask against a REAL database,
// which is the only way to validate the parts of the scheduler a mocked
// PrismaService cannot:
//
//   1. The `skipDedup: true` contract PRODUCES REAL ROWS: with two circles and
//      the flag on, exactly ONE pending `memory_generation` row exists per
//      circle — the thing the (type, mediaItemId IS NULL) global dedup would
//      otherwise collapse into a single row for the whole deployment.
//   2. The `enrichmentJob.groupBy({ by: ['circleId'], _max: { finishedAt } })`
//      interval gate is valid SQL and returns what the task expects, including
//      for a nullable aggregate column.
//   3. The three gates end to end against real rows: an in-flight job blocks a
//      circle; a recent success blocks a circle; an old success does not.
//   4. THE ZERO-COST CONTRACT: with `features.memories` off (the default) and
//      with `MEMORIES_ENABLED=false`, a tick writes NO rows at all.

import { PrismaClient, JobStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import {
  MEMORY_GENERATION_JOB_TYPE,
  MemoriesGenerationTask,
} from '../../src/memories/memories-generation.task';
import { EnrichmentJobService } from '../../src/enrichment/enrichment-job.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';

function resolveDatabaseUrl(): string {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'] as string;
  const host = process.env['POSTGRES_HOST'] ?? 'localhost';
  const port = process.env['POSTGRES_PORT'] ?? '5432';
  const user = process.env['POSTGRES_USER'] ?? 'postgres';
  const password = process.env['POSTGRES_PASSWORD'] ?? 'postgres';
  const db = process.env['POSTGRES_DB'] ?? 'appdb';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

const DATABASE_URL = resolveDatabaseUrl();

describeMaybeDb(
  'Memories generation scheduling (DB_GATED: real PostgreSQL)',
  () => {
    let prisma: PrismaClient;
    let task: MemoriesGenerationTask;
    let settings: { getSettings: jest.Mock };

    const userId = randomUUID();
    const circleAId = randomUUID();
    const circleBId = randomUUID();

    const originalEnv = process.env['MEMORIES_ENABLED'];

    /**
     * Only this suite's two circles exist as far as the assertions are
     * concerned — a shared database may hold others, so every count is scoped
     * to these ids.
     */
    const ourCircles = { in: [circleAId, circleBId] };

    beforeAll(async () => {
      const adapter = new PrismaPg({ connectionString: DATABASE_URL });
      prisma = new PrismaClient({ adapter });
      await prisma.$connect();

      await prisma.user.create({
        data: { id: userId, email: `memories-sched-${userId}@example.test` },
      });
      await prisma.circle.createMany({
        data: [
          { id: circleAId, name: 'Memories Sched A', ownerId: userId },
          { id: circleBId, name: 'Memories Sched B', ownerId: userId },
        ],
      });
    }, 30000);

    afterAll(async () => {
      if (!prisma) return;
      await prisma.enrichmentJob
        .deleteMany({ where: { circleId: ourCircles } })
        .catch(() => undefined);
      await prisma.circle.deleteMany({ where: { id: ourCircles } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();

      if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
      else process.env['MEMORIES_ENABLED'] = originalEnv;
    }, 30000);

    beforeEach(async () => {
      delete process.env['MEMORIES_ENABLED'];
      await prisma.enrichmentJob.deleteMany({ where: { circleId: ourCircles } });

      // Real PrismaService/EnrichmentJobService; only the settings read is
      // stubbed, so every query in the path is genuine SQL.
      settings = {
        getSettings: jest.fn().mockResolvedValue({
          features: { memories: true },
          memories: { generation: { intervalHours: 24 } },
        }),
      };
      task = new MemoriesGenerationTask(
        prisma as unknown as PrismaService,
        new EnrichmentJobService(prisma as unknown as PrismaService),
        settings as unknown as SystemSettingsService,
      );
    });

    /** memory_generation rows belonging to this suite's circles. */
    async function ourJobs() {
      return prisma.enrichmentJob.findMany({
        where: { type: MEMORY_GENERATION_JOB_TYPE, circleId: ourCircles },
        orderBy: { circleId: 'asc' },
      });
    }

    /**
     * Which of THIS SUITE'S circles came out of a tick with a pending job.
     *
     * Assertions go through this rather than through `sweep()`'s `enqueued` /
     * `skipped` counters, which are necessarily DEPLOYMENT-WIDE: the task sweeps
     * every circle in the database, so a circle belonging to another suite
     * running in a parallel Jest worker (the Trips curator suite creates two)
     * lands in those totals and makes an absolute count flaky. The rows are the
     * real assertion anyway — "circle A was gated" is better evidenced by
     * A having no pending job than by a global counter having incremented once.
     */
    async function ourPendingCircleIds(): Promise<string[]> {
      const rows = await prisma.enrichmentJob.findMany({
        where: {
          type: MEMORY_GENERATION_JOB_TYPE,
          circleId: ourCircles,
          status: JobStatus.pending,
        },
        select: { circleId: true },
      });
      return rows.map((r) => r.circleId!).sort();
    }

    // -----------------------------------------------------------------------
    // 1. skipDedup — one job PER CIRCLE, not one for the deployment
    // -----------------------------------------------------------------------

    it('creates exactly one pending job per circle (skipDedup verified against real rows)', async () => {
      await task.sweep();

      const jobs = await ourJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.circleId).sort()).toEqual(
        [circleAId, circleBId].sort(),
      );
      for (const job of jobs) {
        expect(job.status).toBe(JobStatus.pending);
        expect(job.mediaItemId).toBeNull();
        // Background priority — never starves upload enrichment.
        expect(job.priority).toBe(100);
      }
    });

    it('a second tick adds nothing while the first tick\'s jobs are still pending', async () => {
      await task.sweep();
      await task.sweep();

      // Still exactly one row per circle: the second tick's gate saw the first
      // tick's pending jobs and enqueued nothing more.
      expect(await ourJobs()).toHaveLength(2);
      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    // -----------------------------------------------------------------------
    // 2/3. Interval gate against real rows (exercises groupBy + _max SQL)
    // -----------------------------------------------------------------------

    it('skips a circle whose last SUCCEEDED job is inside the interval, enqueues the other', async () => {
      await prisma.enrichmentJob.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          circleId: circleAId,
          status: JobStatus.succeeded,
          reason: 'backfill',
          finishedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago < 24h
        },
      });

      const result = await task.sweep();

      // The sweep covers every circle in the database, so this is a floor.
      expect(result.circles).toBeGreaterThanOrEqual(2);
      // Circle A is gated by its 1h-old success; circle B is not.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    it('enqueues again once the last success falls outside the interval', async () => {
      await prisma.enrichmentJob.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          circleId: circleAId,
          status: JobStatus.succeeded,
          reason: 'backfill',
          finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
        },
      });

      await task.sweep();

      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    it('uses the MOST RECENT success when a circle has several (the _max aggregate)', async () => {
      await prisma.enrichmentJob.createMany({
        data: [
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
          },
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
      });

      await task.sweep();

      // The 2h-old success wins over the 100h-old one → circle A stays gated.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    it('ignores FAILED history — only succeeded jobs gate the interval', async () => {
      await prisma.enrichmentJob.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          circleId: circleAId,
          status: JobStatus.failed,
          reason: 'backfill',
          finishedAt: new Date(),
        },
      });

      await task.sweep();

      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    it('skips a circle with a RUNNING job even when its last success is old', async () => {
      await prisma.enrichmentJob.createMany({
        data: [
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 200 * 60 * 60 * 1000),
          },
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: circleAId,
            status: JobStatus.running,
            reason: 'backfill',
          },
        ],
      });

      await task.sweep();

      // Circle A's in-flight job blocks it despite the 200h-old success.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    // -----------------------------------------------------------------------
    // 4. Zero background cost when off
    // -----------------------------------------------------------------------

    it('writes NOTHING when features.memories is off (the default)', async () => {
      settings.getSettings.mockResolvedValue({ features: {} });

      await task.handleScheduledGeneration();

      expect(await ourJobs()).toHaveLength(0);
    });

    it('writes NOTHING when MEMORIES_ENABLED=false, even with the flag on', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';

      await task.handleScheduledGeneration();

      expect(await ourJobs()).toHaveLength(0);
      expect(settings.getSettings).not.toHaveBeenCalled();
    });
  },
);
