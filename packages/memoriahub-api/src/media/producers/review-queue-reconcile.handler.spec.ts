import { REVIEW_QUEUE_RECONCILE_TYPE } from './review-queue.constants.js';
import { ReviewQueueReconcileHandler } from './review-queue-reconcile.handler.js';
import { ReviewQueueReconcileTask } from './review-queue-reconcile.task.js';

describe('review-queue reconcile job and cron (RETRO-C9 #612, RETRO-J10 #624)', () => {
  afterEach(() => {
    delete process.env['NOTIFICATIONS_RECONCILE_ENABLED'];
  });

  it('keeps the permanent job type, a 15 minute profile and no node pair', () => {
    expect(REVIEW_QUEUE_RECONCILE_TYPE).toBe('notifications.review_queue_reconcile');
    const handler = new ReviewQueueReconcileHandler({ registerHandler: jest.fn() } as never, {} as never);
    expect(handler.type).toBe('notifications.review_queue_reconcile');
    expect(handler.profile).toEqual({ maxRuntimeMs: 900_000, maxAttempts: 3 });
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
  });

  it('registers through the jobs port and reconciles every library on process', async () => {
    const jobs = { registerHandler: jest.fn() };
    const reconcile = { reconcileAll: jest.fn(async () => ({ circles: 2, upserted: 0, resolved: 0, errors: 0 })) };
    const handler = new ReviewQueueReconcileHandler(jobs as never, reconcile as never);
    handler.onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    await handler.process();
    expect(reconcile.reconcileAll).toHaveBeenCalledTimes(1);
  });

  it('lets a reconcile failure fail the job (the queue retries it)', async () => {
    const handler = new ReviewQueueReconcileHandler(
      { registerHandler: jest.fn() } as never,
      { reconcileAll: jest.fn().mockRejectedValue(new Error('reconcile exploded')) } as never,
    );
    await expect(handler.process()).rejects.toThrow('reconcile exploded');
  });

  it('the cron only asks the jobs port for the housekeeping job, and is off when the kill switch says so', async () => {
    const jobs = { enqueueHousekeeping: jest.fn(async () => ({ id: 'job-1' })), enqueue: jest.fn() };
    await new ReviewQueueReconcileTask(jobs as never).handleScheduledReconcile();
    expect(jobs.enqueueHousekeeping).toHaveBeenCalledWith(expect.objectContaining({ type: 'notifications.review_queue_reconcile' }));
    expect(jobs.enqueue).not.toHaveBeenCalled();

    process.env['NOTIFICATIONS_RECONCILE_ENABLED'] = 'false';
    jobs.enqueueHousekeeping.mockClear();
    await new ReviewQueueReconcileTask(jobs as never).handleScheduledReconcile();
    expect(jobs.enqueueHousekeeping).not.toHaveBeenCalled();
  });
});
