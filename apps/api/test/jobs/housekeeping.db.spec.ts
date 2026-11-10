/**
 * The housekeeping job reads and purges against real PostgreSQL (RETRO-C8, #608).
 *
 * A mocked Prisma cannot prove the queries these paths build against the
 * platform `jobs` table: the digest watermark (newest SUCCEEDED
 * `memory_digest` row of the circle, a failed or a running row never counts)
 * and the insights refresh state (newest `storage_insights` row). RETRO-D3
 * (#576) removed the `retention.appNotifications` case: the platform
 * notifications slice owns the inbox purge.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`).
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { dropLibraries, newLibrary } from '../helpers/library';
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';

import { InsightsService } from '@marinoscar/memoriahub-api/insights';
import { MemoryDigestService } from '../../src/memories/digest/memory-digest.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describeMaybeDb('Housekeeping jobs (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let userId: string;
  let circleId: string;
  const jobIds: string[] = [];

  async function jobRow(type: string, status: string, over: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await prisma.job.create({
      data: { id, type, status: status as never, reason: 'backfill', priority: 100, ...over } as never,
    });
    jobIds.push(id);
    return id;
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = new PrismaService();
    await prisma.$connect();
    const user = await prisma.user.create({ data: { email: `housekeeping-${Date.now()}@example.test` } });
    userId = user.id;
    circleId = (await newLibrary(prisma, { ownerId: userId, name: 'Circle Alpha' })).id;
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await dropLibraries(prisma, [circleId]);
    await prisma.user.deleteMany({ where: { id: userId } });
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  it('memory_digest watermark: the newest SUCCEEDED row of the circle, never a failed or running one', async () => {
    const digest = new MemoryDigestService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never);
    const subject = { subjectType: 'circle', subjectId: circleId };

    await expect(digest.lastDigestAt(circleId)).resolves.toBeNull();

    await jobRow('memory_digest', 'succeeded', { ...subject, finishedAt: ago(10) });
    await jobRow('memory_digest', 'succeeded', { ...subject, finishedAt: ago(3) });
    await jobRow('memory_digest', 'failed', { ...subject, finishedAt: ago(1) });
    await jobRow('memory_digest', 'running', { ...subject, startedAt: ago(0) });
    // Another circle's newer digest is not this circle's watermark.
    await jobRow('memory_digest', 'succeeded', { subjectType: 'circle', subjectId: randomUUID(), finishedAt: ago(0) });

    const watermark = await digest.lastDigestAt(circleId);
    expect(watermark?.getTime()).toBeCloseTo(ago(3).getTime(), -4);
  });

  it('storage_insights refresh state follows the newest jobs row of the type', async () => {
    const insights = new InsightsService(prisma, {} as never);
    await prisma.job.deleteMany({ where: { type: 'storage_insights', id: { in: jobIds } } });

    const failed = await jobRow('storage_insights', 'failed', { lastError: 'aggregate failed', createdAt: ago(2) });
    const state = await insights.getRefreshState();
    // Only assert when no other storage_insights row is newer (a shared database).
    if (state.jobId === failed) {
      expect(state).toEqual({ state: 'failed', jobId: failed, lastError: 'aggregate failed' });
    }

    const pending = await jobRow('storage_insights', 'pending', { createdAt: new Date(Date.now() + 1_000) });
    await expect(insights.getRefreshState()).resolves.toEqual({ state: 'pending', jobId: pending, lastError: null });
    await prisma.job.update({ where: { id: pending }, data: { status: 'succeeded' as never, finishedAt: new Date() } });
    await expect(insights.getRefreshState()).resolves.toEqual({ state: 'idle', jobId: null, lastError: null });
  });
});
