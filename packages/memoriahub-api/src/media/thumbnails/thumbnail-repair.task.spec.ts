/**
 * The thumbnail repair cron is enqueue-only (RETRO-J5, #613): it asks the jobs port for a global
 * housekeeping job and does no work inline; `THUMBNAIL_REPAIR_ENABLED=false` stops the enqueue.
 */
import { ThumbnailRepairTask } from './thumbnail-repair.task.js';

describe('ThumbnailRepairTask', () => {
  const original = process.env['THUMBNAIL_REPAIR_ENABLED'];
  afterEach(() => {
    if (original === undefined) delete process.env['THUMBNAIL_REPAIR_ENABLED'];
    else process.env['THUMBNAIL_REPAIR_ENABLED'] = original;
  });

  it('enqueues the global thumbnail_repair housekeeping job and nothing else', async () => {
    delete process.env['THUMBNAIL_REPAIR_ENABLED'];
    const jobs = { enqueueHousekeeping: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    await new ThumbnailRepairTask(jobs as never).handleScheduledRepair();

    expect(jobs.enqueueHousekeeping).toHaveBeenCalledWith({ type: 'thumbnail_repair', what: 'thumbnail repair' });
  });

  it('enqueues nothing when the kill switch is set', async () => {
    process.env['THUMBNAIL_REPAIR_ENABLED'] = 'false';
    const jobs = { enqueueHousekeeping: jest.fn() };

    await new ThumbnailRepairTask(jobs as never).handleScheduledRepair();

    expect(jobs.enqueueHousekeeping).not.toHaveBeenCalled();
  });
});
