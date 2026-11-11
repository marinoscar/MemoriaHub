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
//   2. The `job.groupBy({ by: ['subjectId'], _max: { finishedAt } })`
//      interval gate is valid SQL and returns what the task expects, including
//      for a nullable aggregate column.
//
// Since the jobs cutover (RETRO-C1, #575) the rows live in the platform `jobs`
// table, which has no `circle_id` / `media_item_id` columns: the enqueue facade
// stores a circle-scoped job as the subject ('circle', circleId), so every read
// and every seeded row here goes through `subjectType` / `subjectId`.
//   3. The three gates end to end against real rows: an in-flight job blocks a
//      circle; a recent success blocks a circle; an old success does not.
//   4. THE ZERO-COST CONTRACT: with `features.memories` off (the default) and
//      with `MEMORIES_ENABLED=false`, a tick writes NO rows at all.

import { createSharedLibrary, dropLibraries } from '../helpers/library';
import { PrismaClient, JobStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import {
  MEMORY_GENERATION_JOB_TYPE,
  MemoriesGenerationTask,
  MemoriesSettingsService,
} from '@marinoscar/memoriahub-api/memories';
import { PlatformMemoriahubJobsAdapter } from '../../src/platform-memoriahub/jobs/platform-memoriahub-jobs.adapter';
import { sqlScopeDirectory } from '../helpers/scope-directory';
import { PrismaService } from '../../src/prisma/prisma.service';
import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';

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
    // The settings port the slice reads (`readSystem`): one value per namespace, replaced per test.
    let settings: { readSystem: jest.Mock };
    let values: Record<string, unknown>;

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
    /** The platform job subject the enqueue facade writes for a circle-scoped job. */
    const ourCircleJobs = { subjectType: 'circle', subjectId: ourCircles };

    beforeAll(async () => {
      const adapter = new PrismaPg({ connectionString: DATABASE_URL });
      prisma = new PrismaClient({ adapter });
      await prisma.$connect();

      await prisma.user.create({
        data: { id: userId, email: `memories-sched-${userId}@example.test` },
      });
      await createSharedLibrary(prisma, { id: circleAId, name: 'Memories Sched A', createdById: userId });
      await createSharedLibrary(prisma, { id: circleBId, name: 'Memories Sched B', createdById: userId });
    }, 30000);

    afterAll(async () => {
      if (!prisma) return;
      await prisma.job
        .deleteMany({ where: ourCircleJobs })
        .catch(() => undefined);
      await dropLibraries(prisma, [circleAId, circleBId]);
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();

      if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
      else process.env['MEMORIES_ENABLED'] = originalEnv;
    }, 30000);

    beforeEach(async () => {
      delete process.env['MEMORIES_ENABLED'];
      await prisma.job.deleteMany({ where: ourCircleJobs });

      // Real PrismaService/EnrichmentJobService; only the settings read is
      // stubbed, so every query in the path is genuine SQL.
      values = {
        features: { memories: true },
        memories: { generation: { intervalHours: 24 } },
      };
      settings = {
        readSystem: jest.fn(async (name: string) => ({ value: values[name], version: 1 })),
      };
      // The jobs port over the REAL queue: the web app's adapter on the platform `JobsService`.
      const jobsPort = new PlatformMemoriahubJobsAdapter(
        new JobsService(prisma as never),
        {} as never,
        {} as never,
        {} as never,
        prisma as unknown as PrismaService,
        {} as never,
        new DefaultOrgId(prisma as unknown as PrismaService),
      );
      task = new MemoriesGenerationTask(
        prisma as never,
        sqlScopeDirectory(prisma as never) as never,
        jobsPort,
        new MemoriesSettingsService(settings as never, { digest: { signingKey: () => Buffer.alloc(32) } }),
      );
    });

    /** memory_generation rows belonging to this suite's circles. */
    async function ourJobs() {
      return prisma.job.findMany({
        where: { type: MEMORY_GENERATION_JOB_TYPE, ...ourCircleJobs },
        orderBy: { subjectId: 'asc' },
      });
    }

    /**
     * Which of THIS SUITE'S circles came out of a tick with a pending job.
     *
     * Assertions go through this rather than through the tick's's `enqueued` /
     * `skipped` counters, which are necessarily DEPLOYMENT-WIDE: the task sweeps
     * every circle in the database, so a circle belonging to another suite
     * running in a parallel Jest worker (the Trips curator suite creates two)
     * lands in those totals and makes an absolute count flaky. The rows are the
     * real assertion anyway — "circle A was gated" is better evidenced by
     * A having no pending job than by a global counter having incremented once.
     */
    async function ourPendingCircleIds(): Promise<string[]> {
      const rows = await prisma.job.findMany({
        where: {
          type: MEMORY_GENERATION_JOB_TYPE,
          ...ourCircleJobs,
          status: JobStatus.pending,
        },
        select: { subjectId: true },
      });
      return rows.map((r) => r.subjectId!).sort();
    }

    // -----------------------------------------------------------------------
    // 1. skipDedup — one job PER CIRCLE, not one for the deployment
    // -----------------------------------------------------------------------

    it('creates exactly one pending job per circle (skipDedup verified against real rows)', async () => {
      await task.handleScheduledGeneration();

      const jobs = await ourJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.subjectId).sort()).toEqual(
        [circleAId, circleBId].sort(),
      );
      for (const job of jobs) {
        expect(job.status).toBe(JobStatus.pending);
        // A circle-scoped job: the circle is the subject, no media item.
        expect(job.subjectType).toBe('circle');
        // Background priority — never starves upload enrichment.
        expect(job.priority).toBe(100);
      }
    });

    it('a second tick adds nothing while the first tick\'s jobs are still pending', async () => {
      await task.handleScheduledGeneration();
      await task.handleScheduledGeneration();

      // Still exactly one row per circle: the second tick's gate saw the first
      // tick's pending jobs and enqueued nothing more.
      expect(await ourJobs()).toHaveLength(2);
      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    // -----------------------------------------------------------------------
    // 2/3. Interval gate against real rows (exercises groupBy + _max SQL)
    // -----------------------------------------------------------------------

    it('skips a circle whose last SUCCEEDED job is inside the interval, enqueues the other', async () => {
      await prisma.job.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          subjectType: 'circle',
          subjectId: circleAId,
          status: JobStatus.succeeded,
          reason: 'backfill',
          finishedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago < 24h
        },
      });

      const result = await task.handleScheduledGeneration();

      // The sweep covers every circle in the database, so this is a floor.
      expect(result.circles).toBeGreaterThanOrEqual(2);
      // Circle A is gated by its 1h-old success; circle B is not.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    it('enqueues again once the last success falls outside the interval', async () => {
      await prisma.job.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          subjectType: 'circle',
          subjectId: circleAId,
          status: JobStatus.succeeded,
          reason: 'backfill',
          finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
        },
      });

      await task.handleScheduledGeneration();

      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    it('uses the MOST RECENT success when a circle has several (the _max aggregate)', async () => {
      await prisma.job.createMany({
        data: [
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            subjectType: 'circle',
            subjectId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
          },
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            subjectType: 'circle',
            subjectId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
      });

      await task.handleScheduledGeneration();

      // The 2h-old success wins over the 100h-old one → circle A stays gated.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    it('ignores FAILED history — only succeeded jobs gate the interval', async () => {
      await prisma.job.create({
        data: {
          type: MEMORY_GENERATION_JOB_TYPE,
          subjectType: 'circle',
          subjectId: circleAId,
          status: JobStatus.failed,
          reason: 'backfill',
          finishedAt: new Date(),
        },
      });

      await task.handleScheduledGeneration();

      expect(await ourPendingCircleIds()).toEqual([circleAId, circleBId].sort());
    });

    it('skips a circle with a RUNNING job even when its last success is old', async () => {
      await prisma.job.createMany({
        data: [
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            subjectType: 'circle',
            subjectId: circleAId,
            status: JobStatus.succeeded,
            reason: 'backfill',
            finishedAt: new Date(Date.now() - 200 * 60 * 60 * 1000),
          },
          {
            type: MEMORY_GENERATION_JOB_TYPE,
            subjectType: 'circle',
            subjectId: circleAId,
            status: JobStatus.running,
            reason: 'backfill',
          },
        ],
      });

      await task.handleScheduledGeneration();

      // Circle A's in-flight job blocks it despite the 200h-old success.
      expect(await ourPendingCircleIds()).toEqual([circleBId]);
    });

    // -----------------------------------------------------------------------
    // 4. Zero background cost when off
    // -----------------------------------------------------------------------

    it('writes NOTHING when features.memories is off (the default)', async () => {
      values['features'] = {};

      await task.handleScheduledGeneration();

      expect(await ourJobs()).toHaveLength(0);
    });

    it('writes NOTHING when MEMORIES_ENABLED=false, even with the flag on', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';

      await task.handleScheduledGeneration();

      expect(await ourJobs()).toHaveLength(0);
      expect(settings.readSystem).not.toHaveBeenCalled();
    });
  },
);
