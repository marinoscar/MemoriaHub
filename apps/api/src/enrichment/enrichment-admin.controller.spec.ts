/**
 * Unit tests for EnrichmentAdminController.
 *
 * Verifies that each handler delegates correctly to EnrichmentAdminService.
 * Auth guards are overridden — this is a pure delegation and metadata test.
 * Guard/RBAC enforcement is tested in integration tests.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus } from '@prisma/client';
import { EnrichmentAdminController, ListJobsQueryDto, RetryAllFailedDto, ResetStuckDto } from './enrichment-admin.controller';
import { EnrichmentAdminService } from './enrichment-admin.service';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
// ---------------------------------------------------------------------------
// Mock EnrichmentAdminService
// ---------------------------------------------------------------------------

const mockAdminService = {
  getStats: jest.fn(),
  listJobs: jest.fn(),
  retryJob: jest.fn(),
  retryAllFailed: jest.fn(),
  resetStuck: jest.fn(),
  deleteJob: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-uuid-1',
    type: 'face_detection',
    status: JobStatus.pending,
    reason: 'upload',
    priority: 0,
    mediaItemId: 'media-uuid-1',
    circleId: 'circle-uuid-1',
    attempts: 0,
    lastError: null,
    providerKey: null,
    modelVersion: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeStats() {
  return {
    total: 5,
    byStatus: { pending: 2, running: 1, succeeded: 1, failed: 1 },
    byType: [{ type: 'face_detection', pending: 2, running: 1, succeeded: 1, failed: 1, total: 5 }],
    stuckRunning: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentAdminController', () => {
  let controller: EnrichmentAdminController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnrichmentAdminController],
      providers: [
        { provide: EnrichmentAdminService, useValue: mockAdminService },
      ],
    })
      // Override guards so auth infrastructure is not required in unit tests
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EnrichmentAdminController>(EnrichmentAdminController);
  });

  // =========================================================================
  // GET /admin/jobs/stats — getStats
  // =========================================================================

  describe('getStats', () => {
    it('delegates to adminService.getStats() and returns result', async () => {
      const stats = makeStats();
      mockAdminService.getStats.mockResolvedValue(stats);

      const result = await controller.getStats();

      expect(mockAdminService.getStats).toHaveBeenCalledTimes(1);
      expect(result).toEqual(stats);
    });

    it('is decorated with @Auth requiring ADMIN role and JOBS_READ permission', () => {
      const metadata = Reflect.getMetadata('__guards__', controller.getStats);
      // Verify the handler exists and can be called (guard metadata wiring verified via integration tests;
      // here we confirm the method delegates correctly and the controller compiles with the decorator)
      expect(typeof controller.getStats).toBe('function');
    });
  });

  // =========================================================================
  // GET /admin/jobs — listJobs
  // =========================================================================

  describe('listJobs', () => {
    it('delegates to adminService.listJobs with parsed query params', async () => {
      const listResult = {
        items: [makeJobItem()],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      };
      mockAdminService.listJobs.mockResolvedValue(listResult);

      const query = { status: JobStatus.failed, type: 'ocr', page: 2, pageSize: 10 } as ListJobsQueryDto;
      const result = await controller.listJobs(query);

      expect(mockAdminService.listJobs).toHaveBeenCalledWith({
        status: JobStatus.failed,
        type: 'ocr',
        page: 2,
        pageSize: 10,
      });
      expect(result).toEqual(listResult);
    });

    it('passes undefined status and type when not provided in query', async () => {
      mockAdminService.listJobs.mockResolvedValue({ items: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });

      const query = { page: 1, pageSize: 20 } as ListJobsQueryDto;
      await controller.listJobs(query);

      const listCall = mockAdminService.listJobs.mock.calls[0][0];
      expect(listCall.status).toBeUndefined();
      expect(listCall.type).toBeUndefined();
    });
  });

  // =========================================================================
  // POST /admin/jobs/:id/retry — retryJob
  // =========================================================================

  describe('retryJob', () => {
    it('delegates to adminService.retryJob with the id param', async () => {
      const updatedJob = makeJobItem({ status: JobStatus.pending });
      mockAdminService.retryJob.mockResolvedValue(updatedJob);

      const result = await controller.retryJob('job-uuid-1');

      expect(mockAdminService.retryJob).toHaveBeenCalledWith('job-uuid-1');
      expect(result).toEqual(updatedJob);
    });

    it('propagates NotFoundException from adminService.retryJob', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockAdminService.retryJob.mockRejectedValue(new NotFoundException('Job not found'));

      await expect(controller.retryJob('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('propagates BadRequestException for running job from adminService.retryJob', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      mockAdminService.retryJob.mockRejectedValue(new BadRequestException('Job is running'));

      await expect(controller.retryJob('running-id')).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // POST /admin/jobs/retry-failed — retryAllFailed
  // =========================================================================

  describe('retryAllFailed', () => {
    it('delegates to adminService.retryAllFailed with type from body', async () => {
      mockAdminService.retryAllFailed.mockResolvedValue({ retried: 5 });

      const dto = { type: 'ocr' } as RetryAllFailedDto;
      const result = await controller.retryAllFailed(dto);

      expect(mockAdminService.retryAllFailed).toHaveBeenCalledWith('ocr');
      expect(result).toEqual({ retried: 5 });
    });

    it('passes undefined to adminService.retryAllFailed when body has no type', async () => {
      mockAdminService.retryAllFailed.mockResolvedValue({ retried: 10 });

      const dto = {} as RetryAllFailedDto;
      const result = await controller.retryAllFailed(dto);

      expect(mockAdminService.retryAllFailed).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({ retried: 10 });
    });
  });

  // =========================================================================
  // POST /admin/jobs/reset-stuck — resetStuck
  // =========================================================================

  describe('resetStuck', () => {
    it('delegates to adminService.resetStuck with olderThanMinutes from body', async () => {
      mockAdminService.resetStuck.mockResolvedValue({ reset: 3 });

      const dto = { olderThanMinutes: 15 } as ResetStuckDto;
      const result = await controller.resetStuck(dto);

      expect(mockAdminService.resetStuck).toHaveBeenCalledWith(15);
      expect(result).toEqual({ reset: 3 });
    });

    it('passes undefined to adminService.resetStuck when olderThanMinutes is absent', async () => {
      mockAdminService.resetStuck.mockResolvedValue({ reset: 0 });

      const dto = {} as ResetStuckDto;
      const result = await controller.resetStuck(dto);

      expect(mockAdminService.resetStuck).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({ reset: 0 });
    });

    // -----------------------------------------------------------------------
    // resetStuckSchema (Zod) validation — olderThanMinutes has NO default, so
    // an empty body must validate and let the service resolve the
    // jobs.stuckThresholdMinutes system setting instead.
    // -----------------------------------------------------------------------

    describe('resetStuckSchema validation', () => {
      it('accepts an empty body — olderThanMinutes stays undefined (no default applied)', () => {
        const parsed = ResetStuckDto.create({});

        expect(parsed).toEqual({});
        expect(parsed.olderThanMinutes).toBeUndefined();
      });

      it('accepts an explicit valid olderThanMinutes and passes it through unchanged', () => {
        const parsed = ResetStuckDto.create({ olderThanMinutes: 15 });

        expect(parsed.olderThanMinutes).toBe(15);
      });

      it('accepts the minimum valid value of 1', () => {
        const parsed = ResetStuckDto.create({ olderThanMinutes: 1 });

        expect(parsed.olderThanMinutes).toBe(1);
      });

      it('rejects olderThanMinutes: 0', () => {
        expect(() => ResetStuckDto.create({ olderThanMinutes: 0 })).toThrow();
      });

      it('rejects a negative olderThanMinutes', () => {
        expect(() => ResetStuckDto.create({ olderThanMinutes: -5 })).toThrow();
      });

      it('rejects a non-integer olderThanMinutes', () => {
        expect(() => ResetStuckDto.create({ olderThanMinutes: 15.5 })).toThrow();
      });
    });
  });

  // =========================================================================
  // DELETE /admin/jobs/:id — deleteJob
  // =========================================================================

  describe('deleteJob', () => {
    it('delegates to adminService.deleteJob with the id param', async () => {
      mockAdminService.deleteJob.mockResolvedValue({ deleted: true });

      const result = await controller.deleteJob('job-uuid-1');

      expect(mockAdminService.deleteJob).toHaveBeenCalledWith('job-uuid-1');
      expect(result).toEqual({ deleted: true });
    });

    it('propagates NotFoundException from adminService.deleteJob', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockAdminService.deleteJob.mockRejectedValue(new NotFoundException('Job not found'));

      await expect(controller.deleteJob('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('propagates BadRequestException for running job from adminService.deleteJob', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      mockAdminService.deleteJob.mockRejectedValue(new BadRequestException('Job is running'));

      await expect(controller.deleteJob('running-id')).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // Auth metadata — verify @Auth wiring on controller methods
  // =========================================================================

  describe('@Auth metadata wiring', () => {
    /**
     * Retrieve metadata set on a handler through the Roles / Permissions decorators.
     * The @Auth() composite decorator calls @Roles(...) and @Permissions(...) which
     * set metadata using SetMetadata. We read that metadata directly from each handler.
     */

    it('getStats requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.getStats);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('getStats requires JOBS_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.getStats);
      expect(permissions).toContain(PERMISSIONS.JOBS_READ);
    });

    it('listJobs requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.listJobs);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('listJobs requires JOBS_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.listJobs);
      expect(permissions).toContain(PERMISSIONS.JOBS_READ);
    });

    it('retryJob requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.retryJob);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('retryJob requires JOBS_WRITE permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.retryJob);
      expect(permissions).toContain(PERMISSIONS.JOBS_WRITE);
    });

    it('retryAllFailed requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.retryAllFailed);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('retryAllFailed requires JOBS_WRITE permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.retryAllFailed);
      expect(permissions).toContain(PERMISSIONS.JOBS_WRITE);
    });

    it('resetStuck requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.resetStuck);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('resetStuck requires JOBS_WRITE permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.resetStuck);
      expect(permissions).toContain(PERMISSIONS.JOBS_WRITE);
    });

    it('deleteJob requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.deleteJob);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('deleteJob requires JOBS_WRITE permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.deleteJob);
      expect(permissions).toContain(PERMISSIONS.JOBS_WRITE);
    });
  });
});
