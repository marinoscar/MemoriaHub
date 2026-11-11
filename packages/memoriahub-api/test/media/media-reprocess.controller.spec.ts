/**
 * Unit tests — MediaReprocessController
 *
 * Mock strategy: the jobs port and the job table delegate are jest mocks.
 * Since RETRO-D1b (#567) reprocess, reprocess-stuck and reprocess-failed only
 * ENQUEUE a job and answer { data: { jobId, status } }; the status and priority
 * of the job come from its row.
 * HTTP-level auth enforcement is tested in integration tests, not here.
 */

import { MediaReprocessController } from '../../src/media/index.js';
import type { ReprocessBodyDto, ReprocessStuckBodyDto, ReprocessFailedBodyDto } from '../../src/media/index.js';

describe('MediaReprocessController', () => {
  let controller: MediaReprocessController;
  let mockJobsEnqueue: jest.Mock;
  let mockJobFindUnique: jest.Mock;
  let mockJobUpdate: jest.Mock;

  /** What the queue holds for the job the next `enqueue` answers with (the route reports its status and priority). */
  function givenJob(id: string, status: string, priority: number): void {
    mockJobsEnqueue.mockResolvedValue({ id, deduplicated: false });
    mockJobFindUnique.mockResolvedValue({ status, priority });
  }

  beforeEach(() => {
    mockJobsEnqueue = jest.fn();
    mockJobFindUnique = jest.fn();
    mockJobUpdate = jest.fn().mockResolvedValue({});
    givenJob('job-r-1', 'pending', 0);

    controller = new MediaReprocessController(
      { enqueue: mockJobsEnqueue } as never,
      { job: { findUnique: mockJobFindUnique, update: mockJobUpdate } } as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // reprocess — enqueues media.storage.reprocess (RETRO-D1b)
  // -------------------------------------------------------------------------

  describe('reprocess', () => {
    it('enqueues one system job for the whole library when there is no circleId', async () => {
      const result = await controller.reprocess({} as ReprocessBodyDto);

      expect(mockJobsEnqueue).toHaveBeenCalledWith({
        type: 'media.storage.reprocess',
        reason: 'rerun',
        payload: {},
        orgId: null,
        priority: 0,
      });
      expect(result).toEqual({ data: { jobId: 'job-r-1', status: 'pending' } });
    });

    it('scopes the job (and its dedup slot) to the circle', async () => {
      await controller.reprocess({ circleId: 'circle-a' } as ReprocessBodyDto);

      expect(mockJobsEnqueue).toHaveBeenCalledWith({
        type: 'media.storage.reprocess',
        reason: 'rerun',
        subjectType: 'circle',
        subjectId: 'circle-a',
        payload: { circleId: 'circle-a' },
        orgId: null,
        priority: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // reprocessStuck — enqueues media.storage.recover_stuck, mode stuck
  // -------------------------------------------------------------------------

  describe('reprocessStuck', () => {
    it('enqueues the recovery job at priority 0 with no subject (collapses onto the cron job)', async () => {
      const result = await controller.reprocessStuck({ olderThanMinutes: 30 } as ReprocessStuckBodyDto);

      expect(mockJobsEnqueue).toHaveBeenCalledWith({
        type: 'media.storage.recover_stuck',
        reason: 'rerun',
        payload: { mode: 'stuck', olderThanMinutes: 30 },
        orgId: null,
        priority: 0,
      });
      expect(result).toEqual({ data: { jobId: 'job-r-1', status: 'pending' } });
      expect(mockJobUpdate).not.toHaveBeenCalled();
    });

    it('omits olderThanMinutes when the body has none', async () => {
      await controller.reprocessStuck({} as ReprocessStuckBodyDto);

      expect(mockJobsEnqueue.mock.calls[0][0].payload).toEqual({ mode: 'stuck' });
    });

    it("promotes the cron's pending job (priority 100) to 0 and returns its id", async () => {
      givenJob('job-cron', 'pending', 100);

      const result = await controller.reprocessStuck({} as ReprocessStuckBodyDto);

      expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-cron' }, data: { priority: 0 } });
      expect(result).toEqual({ data: { jobId: 'job-cron', status: 'pending' } });
    });

    it('leaves a running job alone', async () => {
      givenJob('job-run', 'running', 100);

      await controller.reprocessStuck({} as ReprocessStuckBodyDto);

      expect(mockJobUpdate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // reprocessFailed — enqueues media.storage.recover_stuck, mode failed (issue #106)
  // -------------------------------------------------------------------------

  describe('reprocessFailed', () => {
    it('enqueues the failed mode in its own dedup slot', async () => {
      const result = await controller.reprocessFailed({ limit: 25 } as ReprocessFailedBodyDto);

      expect(mockJobsEnqueue).toHaveBeenCalledWith({
        type: 'media.storage.recover_stuck',
        reason: 'rerun',
        subjectType: 'system',
        subjectId: 'failed',
        payload: { mode: 'failed', limit: 25 },
        orgId: null,
        priority: 0,
      });
      expect(result).toEqual({ data: { jobId: 'job-r-1', status: 'pending' } });
    });

    it('omits limit when the body has none', async () => {
      await controller.reprocessFailed({} as ReprocessFailedBodyDto);

      expect(mockJobsEnqueue.mock.calls[0][0].payload).toEqual({ mode: 'failed' });
    });
  });

  // -------------------------------------------------------------------------
  // repairThumbnails — thumbnail_repair enqueue + dedup
  // -------------------------------------------------------------------------

  describe('repairThumbnails', () => {
    it('should enqueue a global thumbnail_repair job at priority 0 with reason rerun', async () => {
      await controller.repairThumbnails();

      expect(mockJobsEnqueue).toHaveBeenCalledTimes(1);
      expect(mockJobsEnqueue).toHaveBeenCalledWith({
        type: 'thumbnail_repair',
        reason: 'rerun',
        payload: {},
        priority: 0,
      });
    });

    it('should return { data: { jobId, status } } for a freshly enqueued job without touching its priority', async () => {
      givenJob('job-fresh-42', 'pending', 0);

      const result = await controller.repairThumbnails();

      expect(result).toEqual({ data: { jobId: 'job-fresh-42', status: 'pending' } });
      // Already at priority 0 — no promotion write needed
      expect(mockJobUpdate).not.toHaveBeenCalled();
    });

    it('should promote an existing PENDING lower-priority job (cron, priority 100) to priority 0 and return its id', async () => {
      // The queue dedups a global job and returns the existing pending/running row
      // instead of creating a new one.
      givenJob('job-cron-9', 'pending', 100);

      const result = await controller.repairThumbnails();

      expect(mockJobUpdate).toHaveBeenCalledTimes(1);
      expect(mockJobUpdate).toHaveBeenCalledWith({
        where: { id: 'job-cron-9' },
        data: { priority: 0 },
      });
      expect(result).toEqual({ data: { jobId: 'job-cron-9', status: 'pending' } });
    });

    it("should surface an existing RUNNING job's id without updating its priority", async () => {
      givenJob('job-existing-7', 'running', 100);

      const result = await controller.repairThumbnails();

      // Running jobs are already being worked on — never touched
      expect(mockJobUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ data: { jobId: 'job-existing-7', status: 'running' } });
    });

    it('should propagate enqueue failures', async () => {
      mockJobsEnqueue.mockRejectedValue(new Error('DB unavailable'));

      await expect(controller.repairThumbnails()).rejects.toThrow('DB unavailable');
    });
  });
});
