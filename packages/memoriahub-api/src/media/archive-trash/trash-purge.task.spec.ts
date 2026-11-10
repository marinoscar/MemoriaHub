/**
 * The trash purge cron is enqueue-only (RETRO-J5, #613): it asks the jobs port for a global
 * housekeeping job and does no work inline.
 */
import { TrashPurgeTask } from './trash-purge.task.js';

describe('TrashPurgeTask', () => {
  it('enqueues the global trash_purge housekeeping job and nothing else', async () => {
    const jobs = { enqueueHousekeeping: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    await new TrashPurgeTask(jobs as never).handleScheduledPurge();

    expect(jobs.enqueueHousekeeping).toHaveBeenCalledWith({ type: 'trash_purge', what: 'trash purge' });
  });
});
