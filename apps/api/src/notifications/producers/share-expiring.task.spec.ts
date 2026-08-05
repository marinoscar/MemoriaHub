/**
 * Unit tests for ShareExpiringTask (epic #240, issue #247).
 *
 * Same shape as notification-reconcile.task.spec.ts (#246's closest
 * precedent). Covers:
 *  - the in-process overlap guard: a second tick while one sweep is still
 *    running is SKIPPED, not run concurrently
 *  - the guard is released in a `finally`, so a THROWING sweep does not wedge
 *    the task permanently — a later tick proceeds normally
 *  - NOTIFICATIONS_SHARE_EXPIRING_ENABLED=false disables the sweep entirely
 *  - the task itself never throws out of handleScheduledSweep() — this is
 *    also the cross-cutting "producer never throws to its caller" contract
 *    for share_expiring, since ShareExpiringService.sweep() itself does NOT
 *    swallow a top-level query failure (see share-expiring.service.spec.ts)
 */

import { Test, TestingModule } from '@nestjs/testing';

import { ShareExpiringService } from './share-expiring.service';
import { ShareExpiringTask } from './share-expiring.task';

function emptyResult() {
  return { candidates: 0, emitted: 0, skipped: 0, errors: 0 };
}

describe('ShareExpiringTask', () => {
  let task: ShareExpiringTask;
  let mockShareExpiring: { sweep: jest.Mock };

  beforeEach(async () => {
    delete process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'];

    mockShareExpiring = { sweep: jest.fn().mockResolvedValue(emptyResult()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareExpiringTask,
        { provide: ShareExpiringService, useValue: mockShareExpiring },
      ],
    }).compile();

    task = module.get<ShareExpiringTask>(ShareExpiringTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'];
  });

  // -------------------------------------------------------------------------
  // Overlap guard
  // -------------------------------------------------------------------------

  describe('overlap guard', () => {
    it('a second tick fired while the first is still in flight is SKIPPED, not run concurrently', async () => {
      let resolveFirst!: () => void;
      const firstSweep = new Promise<ReturnType<typeof emptyResult>>((resolve) => {
        resolveFirst = () => resolve(emptyResult());
      });
      mockShareExpiring.sweep.mockReturnValueOnce(firstSweep);

      const firstCall = task.handleScheduledSweep();
      const secondCall = task.handleScheduledSweep();

      await secondCall;
      expect(mockShareExpiring.sweep).toHaveBeenCalledTimes(1);

      resolveFirst();
      await firstCall;
    });

    it('is released in a finally: a THROWING sweep does not permanently wedge the guard', async () => {
      mockShareExpiring.sweep.mockRejectedValueOnce(new Error('sweep exploded'));

      await expect(task.handleScheduledSweep()).resolves.toBeUndefined();

      mockShareExpiring.sweep.mockResolvedValueOnce(emptyResult());
      await task.handleScheduledSweep();

      expect(mockShareExpiring.sweep).toHaveBeenCalledTimes(2);
    });

    it('a normal (non-throwing) run also releases the guard for the next tick', async () => {
      await task.handleScheduledSweep();
      await task.handleScheduledSweep();

      expect(mockShareExpiring.sweep).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Env kill-switch
  // -------------------------------------------------------------------------

  describe('NOTIFICATIONS_SHARE_EXPIRING_ENABLED kill-switch', () => {
    it('disables the sweep entirely when set to "false"', async () => {
      process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] = 'false';

      await task.handleScheduledSweep();

      expect(mockShareExpiring.sweep).not.toHaveBeenCalled();
    });

    it('runs normally when the env var is unset', async () => {
      delete process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'];

      await task.handleScheduledSweep();

      expect(mockShareExpiring.sweep).toHaveBeenCalledTimes(1);
    });

    it('runs normally for any value other than the literal string "false"', async () => {
      process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] = 'true';

      await task.handleScheduledSweep();

      expect(mockShareExpiring.sweep).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting best-effort contract
  // -------------------------------------------------------------------------

  describe('best-effort contract', () => {
    it('handleScheduledSweep() never throws to its caller (the @Cron scheduler) even when sweep() rejects', async () => {
      mockShareExpiring.sweep.mockRejectedValue(new Error('db down'));

      await expect(task.handleScheduledSweep()).resolves.toBeUndefined();
    });
  });
});
