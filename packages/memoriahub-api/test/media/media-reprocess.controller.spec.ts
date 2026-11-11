/**
 * Unit tests — MediaReprocessController
 *
 * Mock strategy: the platform JobsService and EnrichmentJobService are jest mocks.
 * Since RETRO-D1b (#567) reprocess, reprocess-stuck and reprocess-failed only
 * ENQUEUE a job and answer { data: { jobId, status } }.
 * Auth guards (JwtAuthGuard, RolesGuard, PermissionsGuard) are overridden to
 * allow=true so we can test method delegation without auth infrastructure.
 * HTTP-level auth enforcement is tested in integration tests, not here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, MhLegacyJobStatus } from '@prisma/client';
import {
  MediaReprocessController,
  ReprocessBodyDto,
  ReprocessStuckBodyDto,
  ReprocessFailedBodyDto,
} from './media-reprocess.controller';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard } from '@marinoscar/platform-api/identity';

const allowAllGuard = { canActivate: () => true };

describe('MediaReprocessController', () => {
  let controller: MediaReprocessController;
  let mockJobsEnqueue: jest.Mock;
  let mockEnqueue: jest.Mock;
  let mockJobUpdate: jest.Mock;

  beforeEach(async () => {
    mockJobsEnqueue = jest.fn().mockResolvedValue({ id: 'job-r-1', status: 'pending', priority: 0 });
    mockEnqueue = jest.fn().mockResolvedValue({ id: 'job-new-1', status: MhLegacyJobStatus.pending, priority: 0 });
    mockJobUpdate = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaReprocessController],
      providers: [
        { provide: JobsService, useValue: { enqueue: mockJobsEnqueue } },
        {
          provide: EnrichmentJobService,
          useValue: {
            enqueue: mockEnqueue,
          },
        },
        {
          provide: PrismaService,
          useValue: {
            job: {
              update: mockJobUpdate,
            },
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(allowAllGuard)
      .overrideGuard(RolesGuard).useValue(allowAllGuard)
      .overrideGuard(PermissionsGuard).useValue(allowAllGuard)
      .compile();

    controller = module.get<MediaReprocessController>(MediaReprocessController);
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
      mockJobsEnqueue.mockResolvedValue({ id: 'job-cron', status: 'pending', priority: 100 });

      const result = await controller.reprocessStuck({} as ReprocessStuckBodyDto);

      expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-cron' }, data: { priority: 0 } });
      expect(result).toEqual({ data: { jobId: 'job-cron', status: 'pending' } });
    });

    it('leaves a running job alone', async () => {
      mockJobsEnqueue.mockResolvedValue({ id: 'job-run', status: 'running', priority: 100 });

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

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({
        type: 'thumbnail_repair',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.rerun,
        priority: 0,
      });
    });

    it('should return { data: { jobId, status } } for a freshly enqueued job without touching its priority', async () => {
      mockEnqueue.mockResolvedValue({ id: 'job-fresh-42', status: MhLegacyJobStatus.pending, priority: 0 });

      const result = await controller.repairThumbnails();

      expect(result).toEqual({ data: { jobId: 'job-fresh-42', status: MhLegacyJobStatus.pending } });
      // Already at priority 0 — no promotion write needed
      expect(mockJobUpdate).not.toHaveBeenCalled();
    });

    it('should promote an existing PENDING lower-priority job (cron, priority 100) to priority 0 and return its id', async () => {
      // EnrichmentJobService.enqueue dedups (type, mediaItemId IS NULL) jobs and
      // returns the existing pending/running row instead of creating a new one.
      mockEnqueue.mockResolvedValue({ id: 'job-cron-9', status: MhLegacyJobStatus.pending, priority: 100 });

      const result = await controller.repairThumbnails();

      expect(mockJobUpdate).toHaveBeenCalledTimes(1);
      expect(mockJobUpdate).toHaveBeenCalledWith({
        where: { id: 'job-cron-9' },
        data: { priority: 0 },
      });
      expect(result).toEqual({ data: { jobId: 'job-cron-9', status: MhLegacyJobStatus.pending } });
    });

    it("should surface an existing RUNNING job's id without updating its priority", async () => {
      mockEnqueue.mockResolvedValue({ id: 'job-existing-7', status: MhLegacyJobStatus.running, priority: 100 });

      const result = await controller.repairThumbnails();

      // Running jobs are already being worked on — never touched
      expect(mockJobUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ data: { jobId: 'job-existing-7', status: MhLegacyJobStatus.running } });
    });

    it('should propagate enqueue failures', async () => {
      mockEnqueue.mockRejectedValue(new Error('DB unavailable'));

      await expect(controller.repairThumbnails()).rejects.toThrow('DB unavailable');
    });
  });
});
