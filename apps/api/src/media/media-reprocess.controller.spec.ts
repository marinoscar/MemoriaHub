/**
 * Unit tests — MediaReprocessController
 *
 * Mock strategy: MediaReprocessService is replaced with a jest mock.
 * Auth guards (JwtAuthGuard, RolesGuard, PermissionsGuard) are overridden to
 * allow=true so we can test method delegation without auth infrastructure.
 * HTTP-level auth enforcement is tested in integration tests, not here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';
import { MediaReprocessController, ReprocessBodyDto, ReprocessStuckBodyDto } from './media-reprocess.controller';
import { MediaReprocessService } from './media-reprocess.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

const allowAllGuard = { canActivate: () => true };

describe('MediaReprocessController', () => {
  let controller: MediaReprocessController;
  let mockReprocessCircle: jest.Mock;
  let mockRecoverStuckObjects: jest.Mock;
  let mockEnqueue: jest.Mock;
  let mockJobUpdate: jest.Mock;

  beforeEach(async () => {
    mockReprocessCircle = jest.fn().mockResolvedValue({ reprocessed: 3, failed: 0 });
    mockRecoverStuckObjects = jest.fn().mockResolvedValue({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });
    mockEnqueue = jest.fn().mockResolvedValue({ id: 'job-new-1', status: JobStatus.pending, priority: 0 });
    mockJobUpdate = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaReprocessController],
      providers: [
        {
          provide: MediaReprocessService,
          useValue: {
            reprocessCircle: mockReprocessCircle,
          },
        },
        {
          provide: StorageProcessingRecoveryService,
          useValue: {
            recoverStuckObjects: mockRecoverStuckObjects,
          },
        },
        {
          provide: EnrichmentJobService,
          useValue: {
            enqueue: mockEnqueue,
          },
        },
        {
          provide: PrismaService,
          useValue: {
            enrichmentJob: {
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
  // reprocess — delegation to service
  // -------------------------------------------------------------------------

  describe('reprocess', () => {
    it('should call reprocessCircle with undefined when body has no circleId', async () => {
      const body = {} as ReprocessBodyDto;

      await controller.reprocess(body);

      expect(mockReprocessCircle).toHaveBeenCalledWith(undefined);
    });

    it('should call reprocessCircle with the provided circleId', async () => {
      const body = { circleId: 'abc123-uuid' } as ReprocessBodyDto;

      await controller.reprocess(body);

      expect(mockReprocessCircle).toHaveBeenCalledWith('abc123-uuid');
    });

    it('should return the service result directly', async () => {
      mockReprocessCircle.mockResolvedValue({ reprocessed: 5, failed: 2 });
      const body = {} as ReprocessBodyDto;

      const result = await controller.reprocess(body);

      expect(result).toEqual({ reprocessed: 5, failed: 2 });
    });

    it('should return { reprocessed: 0, failed: 0 } when service returns zeros', async () => {
      mockReprocessCircle.mockResolvedValue({ reprocessed: 0, failed: 0 });
      const body = {} as ReprocessBodyDto;

      const result = await controller.reprocess(body);

      expect(result).toEqual({ reprocessed: 0, failed: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // reprocessStuck — delegation to StorageProcessingRecoveryService
  // -------------------------------------------------------------------------

  describe('reprocessStuck', () => {
    it('should call recoverStuckObjects with undefined when body has no olderThanMinutes', async () => {
      const body = {} as ReprocessStuckBodyDto;

      await controller.reprocessStuck(body);

      expect(mockRecoverStuckObjects).toHaveBeenCalledWith(undefined);
    });

    it('should call recoverStuckObjects with the provided olderThanMinutes', async () => {
      const body = { olderThanMinutes: 30 } as ReprocessStuckBodyDto;

      await controller.reprocessStuck(body);

      expect(mockRecoverStuckObjects).toHaveBeenCalledWith(30);
    });

    it('should return the service result directly', async () => {
      mockRecoverStuckObjects.mockResolvedValue({ claimed: 5, reprocessed: 4, exhausted: 1, errors: 0 });
      const body = {} as ReprocessStuckBodyDto;

      const result = await controller.reprocessStuck(body);

      expect(result).toEqual({ claimed: 5, reprocessed: 4, exhausted: 1, errors: 0 });
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
      mockEnqueue.mockResolvedValue({ id: 'job-fresh-42', status: JobStatus.pending, priority: 0 });

      const result = await controller.repairThumbnails();

      expect(result).toEqual({ data: { jobId: 'job-fresh-42', status: JobStatus.pending } });
      // Already at priority 0 — no promotion write needed
      expect(mockJobUpdate).not.toHaveBeenCalled();
    });

    it('should promote an existing PENDING lower-priority job (cron, priority 100) to priority 0 and return its id', async () => {
      // EnrichmentJobService.enqueue dedups (type, mediaItemId IS NULL) jobs and
      // returns the existing pending/running row instead of creating a new one.
      mockEnqueue.mockResolvedValue({ id: 'job-cron-9', status: JobStatus.pending, priority: 100 });

      const result = await controller.repairThumbnails();

      expect(mockJobUpdate).toHaveBeenCalledTimes(1);
      expect(mockJobUpdate).toHaveBeenCalledWith({
        where: { id: 'job-cron-9' },
        data: { priority: 0 },
      });
      expect(result).toEqual({ data: { jobId: 'job-cron-9', status: JobStatus.pending } });
    });

    it("should surface an existing RUNNING job's id without updating its priority", async () => {
      mockEnqueue.mockResolvedValue({ id: 'job-existing-7', status: JobStatus.running, priority: 100 });

      const result = await controller.repairThumbnails();

      // Running jobs are already being worked on — never touched
      expect(mockJobUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ data: { jobId: 'job-existing-7', status: JobStatus.running } });
    });

    it('should propagate enqueue failures', async () => {
      mockEnqueue.mockRejectedValue(new Error('DB unavailable'));

      await expect(controller.repairThumbnails()).rejects.toThrow('DB unavailable');
    });
  });
});
