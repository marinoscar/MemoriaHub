/**
 * Unit tests for NotificationReconcileTask (epic #240, issue #246).
 *
 * Covers:
 *  - the in-flight overlap guard: a second handleScheduledReconcile() call
 *    while one is still running is SKIPPED, not run concurrently
 *  - the guard is released in a `finally`, so a throwing sweep does not wedge
 *    the task permanently -- a later run proceeds normally
 *  - NOTIFICATIONS_RECONCILE_ENABLED=false disables the sweep entirely
 *  - reconcileAll() itself never throws out of the task (it is wrapped in a
 *    try/catch), verified via the sweep-recovers-after-failure case above
 */

import { Test, TestingModule } from '@nestjs/testing';

import { NotificationReconcileTask } from './notification-reconcile.task';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

function emptyResult() {
  return { circles: 0, upserted: 0, resolved: 0, reunread: 0, errors: 0 };
}

describe('NotificationReconcileTask', () => {
  let task: NotificationReconcileTask;
  let mockReconcile: { reconcileAll: jest.Mock };

  beforeEach(async () => {
    delete process.env['NOTIFICATIONS_RECONCILE_ENABLED'];

    mockReconcile = { reconcileAll: jest.fn().mockResolvedValue(emptyResult()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationReconcileTask,
        { provide: ReviewQueueReconcileService, useValue: mockReconcile },
      ],
    }).compile();

    task = module.get<NotificationReconcileTask>(NotificationReconcileTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['NOTIFICATIONS_RECONCILE_ENABLED'];
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
      mockReconcile.reconcileAll.mockReturnValueOnce(firstSweep);

      const firstCall = task.handleScheduledReconcile();
      // Second tick fires while the first sweep's promise is still pending.
      const secondCall = task.handleScheduledReconcile();

      await secondCall;
      // Only ONE reconcileAll() invocation happened -- the second tick
      // returned immediately without starting a second sweep.
      expect(mockReconcile.reconcileAll).toHaveBeenCalledTimes(1);

      resolveFirst();
      await firstCall;
    });

    it('is released in a finally: a THROWING sweep does not permanently wedge the guard', async () => {
      mockReconcile.reconcileAll.mockRejectedValueOnce(new Error('sweep exploded'));

      // The task itself must not throw -- handleScheduledReconcile wraps
      // reconcileAll() in a try/catch.
      await expect(task.handleScheduledReconcile()).resolves.toBeUndefined();

      // A later tick proceeds normally (the guard was released in `finally`,
      // not left stuck at true).
      mockReconcile.reconcileAll.mockResolvedValueOnce(emptyResult());
      await task.handleScheduledReconcile();

      expect(mockReconcile.reconcileAll).toHaveBeenCalledTimes(2);
    });

    it('a normal (non-throwing) run also releases the guard for the next tick', async () => {
      await task.handleScheduledReconcile();
      await task.handleScheduledReconcile();

      expect(mockReconcile.reconcileAll).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Env kill-switch
  // -------------------------------------------------------------------------

  describe('NOTIFICATIONS_RECONCILE_ENABLED kill-switch', () => {
    it('disables the sweep entirely when set to "false"', async () => {
      process.env['NOTIFICATIONS_RECONCILE_ENABLED'] = 'false';

      await task.handleScheduledReconcile();

      expect(mockReconcile.reconcileAll).not.toHaveBeenCalled();
    });

    it('runs normally when the env var is unset', async () => {
      delete process.env['NOTIFICATIONS_RECONCILE_ENABLED'];

      await task.handleScheduledReconcile();

      expect(mockReconcile.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('runs normally for any value other than the literal string "false"', async () => {
      process.env['NOTIFICATIONS_RECONCILE_ENABLED'] = 'true';

      await task.handleScheduledReconcile();

      expect(mockReconcile.reconcileAll).toHaveBeenCalledTimes(1);
    });
  });
});
