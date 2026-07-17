/**
 * Unit tests for NodeOfflinePruneTask — offline worker-node retention pruner.
 *
 * Covers:
 *  1. prune — deletes stale offline nodes with no running claimed jobs
 *  2. prune — skips nodes that still have a job running under their claim
 *  3. prune — respects the retention window: the candidate query only targets
 *     offline nodes whose heartbeat (or registration, when never heartbeated)
 *     is older than NODE_OFFLINE_RETENTION_DAYS (default 14)
 *  4. prune — no-ops (no delete query) when there are no candidates
 *  5. handleCron — swallows and logs errors instead of throwing into the
 *     scheduler
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, NodeStatus } from '@prisma/client';
import { NodeOfflinePruneTask } from './node-offline-prune.task';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const DAY_MS = 86_400_000;

describe('NodeOfflinePruneTask', () => {
  let task: NodeOfflinePruneTask;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeOfflinePruneTask,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    task = module.get(NodeOfflinePruneTask);

    // Defaults: no candidates, no busy nodes, delete removes nothing.
    (mockPrisma.workerNode.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.workerNode.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.NODE_OFFLINE_RETENTION_DAYS;
  });

  it('prunes a stale offline node with no running claimed jobs', async () => {
    (mockPrisma.workerNode.findMany as jest.Mock).mockResolvedValue([{ id: 'dead-1' }]);
    (mockPrisma.workerNode.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const pruned = await task.prune();

    expect(pruned).toBe(1);
    expect(mockPrisma.workerNode.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['dead-1'] } },
    });
  });

  it('skips a node that still has a job running under its claim', async () => {
    (mockPrisma.workerNode.findMany as jest.Mock).mockResolvedValue([
      { id: 'dead-1' },
      { id: 'busy-1' },
    ]);
    (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([
      { claimedByNodeId: 'busy-1' },
    ]);
    (mockPrisma.workerNode.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const pruned = await task.prune();

    expect(pruned).toBe(1);
    // The busy-check is scoped to RUNNING jobs claimed by the candidates.
    expect(mockPrisma.enrichmentJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          claimedByNodeId: { in: ['dead-1', 'busy-1'] },
          status: JobStatus.running,
        },
      }),
    );
    // Only the idle dead node is deleted — never the one with a running claim.
    expect(mockPrisma.workerNode.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['dead-1'] } },
    });
  });

  it('no-ops entirely when every candidate has a running claimed job', async () => {
    (mockPrisma.workerNode.findMany as jest.Mock).mockResolvedValue([{ id: 'busy-1' }]);
    (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([
      { claimedByNodeId: 'busy-1' },
    ]);

    const pruned = await task.prune();

    expect(pruned).toBe(0);
    expect(mockPrisma.workerNode.deleteMany).not.toHaveBeenCalled();
  });

  it('respects the retention window: candidates are offline nodes past the cutoff (default 14 days)', async () => {
    const before = Date.now();
    await task.prune();
    const after = Date.now();

    const where = (mockPrisma.workerNode.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe(NodeStatus.offline);

    // Cutoff must be ~14 days before "now" (allowing for the call's own runtime).
    const heartbeatCutoff: Date = where.OR[0].lastHeartbeatAt.lt;
    expect(heartbeatCutoff.getTime()).toBeGreaterThanOrEqual(before - 14 * DAY_MS);
    expect(heartbeatCutoff.getTime()).toBeLessThanOrEqual(after - 14 * DAY_MS);

    // Never-heartbeated nodes are aged by registeredAt with the same cutoff.
    expect(where.OR[1]).toEqual({
      lastHeartbeatAt: null,
      registeredAt: { lt: heartbeatCutoff },
    });
  });

  it('honors a NODE_OFFLINE_RETENTION_DAYS override', async () => {
    process.env.NODE_OFFLINE_RETENTION_DAYS = '30';
    const before = Date.now();

    await task.prune();

    const where = (mockPrisma.workerNode.findMany as jest.Mock).mock.calls[0][0].where;
    const cutoff: Date = where.OR[0].lastHeartbeatAt.lt;
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 30 * DAY_MS);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
  });

  it('does not query jobs or delete anything when there are no candidates', async () => {
    const pruned = await task.prune();

    expect(pruned).toBe(0);
    expect(mockPrisma.enrichmentJob.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.workerNode.deleteMany).not.toHaveBeenCalled();
  });

  it('handleCron swallows and logs errors instead of throwing into the scheduler', async () => {
    const errorSpy = jest
      .spyOn(task['logger'], 'error')
      .mockImplementation(() => undefined);
    (mockPrisma.workerNode.findMany as jest.Mock).mockRejectedValue(
      new Error('db unreachable'),
    );

    await expect(task.handleCron()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
