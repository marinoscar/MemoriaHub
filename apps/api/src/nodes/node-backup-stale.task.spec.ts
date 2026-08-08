/**
 * Unit tests for NodeBackupStaleTask (issue #312) — the 10-minute sweep that
 * releases running backup runs with no ack inside backup.runStaleMinutes.
 * Delegates the actual updateMany to NodeBackupService.markStaleRuns (covered
 * in node-backup.service.spec.ts); this spec pins the never-throws contract.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NodeBackupStaleTask } from './node-backup-stale.task';
import { NodeBackupService } from './node-backup.service';

describe('NodeBackupStaleTask', () => {
  let task: NodeBackupStaleTask;
  let backupService: { markStaleRuns: jest.Mock };

  beforeEach(async () => {
    backupService = { markStaleRuns: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeBackupStaleTask,
        { provide: NodeBackupService, useValue: backupService },
      ],
    }).compile();

    task = module.get(NodeBackupStaleTask);
  });

  it('invokes the stale-run sweep', async () => {
    backupService.markStaleRuns.mockResolvedValue(3);
    await task.handleStaleSweep();
    expect(backupService.markStaleRuns).toHaveBeenCalledTimes(1);
  });

  it('never throws when the sweep fails', async () => {
    backupService.markStaleRuns.mockRejectedValue(new Error('db down'));
    await expect(task.handleStaleSweep()).resolves.toBeUndefined();
  });
});
