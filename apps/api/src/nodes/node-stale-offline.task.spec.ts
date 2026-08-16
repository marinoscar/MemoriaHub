/**
 * Unit tests for NodeStaleOfflineTask (issue #438 defect 6) — the 10-minute
 * sweep that flips nodes silent past the offline threshold to
 * status='offline'.
 *
 * The set-based updateMany itself lives in NodesService.markStaleNodesOffline
 * (covered in nodes.service.spec.ts); this spec pins the cron contract:
 * delegation, the NODE_STALE_OFFLINE_ENABLED kill-switch, and never throwing
 * into the scheduler.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NodeStaleOfflineTask } from './node-stale-offline.task';
import { NodesService } from './nodes.service';

describe('NodeStaleOfflineTask', () => {
  let task: NodeStaleOfflineTask;
  let nodesService: { markStaleNodesOffline: jest.Mock };

  beforeEach(async () => {
    nodesService = { markStaleNodesOffline: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeStaleOfflineTask,
        { provide: NodesService, useValue: nodesService },
      ],
    }).compile();

    task = module.get(NodeStaleOfflineTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.NODE_STALE_OFFLINE_ENABLED;
  });

  it('invokes the staleness sweep', async () => {
    nodesService.markStaleNodesOffline.mockResolvedValue(3);

    await task.handleStaleSweep();

    expect(nodesService.markStaleNodesOffline).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when NODE_STALE_OFFLINE_ENABLED=false', async () => {
    process.env.NODE_STALE_OFFLINE_ENABLED = 'false';

    await task.handleStaleSweep();

    expect(nodesService.markStaleNodesOffline).not.toHaveBeenCalled();
  });

  it('stays enabled for any value other than the literal "false"', async () => {
    process.env.NODE_STALE_OFFLINE_ENABLED = 'true';
    await task.handleStaleSweep();
    expect(nodesService.markStaleNodesOffline).toHaveBeenCalledTimes(1);
  });

  it('logs a count only when something was actually transitioned', async () => {
    const logSpy = jest.spyOn(task['logger'], 'log').mockImplementation(() => undefined);

    nodesService.markStaleNodesOffline.mockResolvedValue(0);
    await task.handleStaleSweep();
    expect(logSpy).not.toHaveBeenCalled();

    nodesService.markStaleNodesOffline.mockResolvedValue(2);
    await task.handleStaleSweep();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
  });

  it('never throws when the sweep fails', async () => {
    const errorSpy = jest
      .spyOn(task['logger'], 'error')
      .mockImplementation(() => undefined);
    nodesService.markStaleNodesOffline.mockRejectedValue(new Error('db down'));

    await expect(task.handleStaleSweep()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
