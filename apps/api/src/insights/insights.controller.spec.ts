/**
 * Unit tests for InsightsController.
 *
 * Verifies handler delegation to InsightsService and the DTO shape returned
 * for both ready and empty states, including the new `refresh` state field.
 * Also verifies POST /admin/insights/refresh enqueues and returns { jobId, state }.
 * Also asserts @Auth metadata wiring (role + permission decorators).
 *
 * Auth guards are overridden — RBAC enforcement is covered by integration tests.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus } from '@prisma/client';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';

// ---------------------------------------------------------------------------
// Mock InsightsService
// ---------------------------------------------------------------------------

const mockInsightsService = {
  getLatest: jest.fn(),
  getRefreshState: jest.fn(),
  enqueueRefresh: jest.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReadySnapshot() {
  return {
    id: 'snap-1',
    status: 'ready',
    metrics: {
      totalBytes: '1260000000',
      photoBytes: '472000000',
      videoBytes: '788000000',
      totalItems: 1000,
      photoCount: 800,
      videoCount: 200,
      totalFaces: 4217,
      taggedItems: 650,
    },
    computedAt: new Date('2025-06-20T10:00:00.000Z'),
    durationMs: 142,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const idleRefreshState = { state: 'idle' as const, jobId: null, lastError: null };
const pendingRefreshState = { state: 'pending' as const, jobId: 'job-1', lastError: null };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsController', () => {
  let controller: InsightsController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        { provide: InsightsService, useValue: mockInsightsService },
      ],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<InsightsController>(InsightsController);
  });

  // =========================================================================
  // GET /admin/insights — getLatest
  // =========================================================================

  describe('getLatest', () => {
    it('returns ready status with metrics and timestamps when snapshot exists', async () => {
      const snapshot = makeReadySnapshot();
      mockInsightsService.getLatest.mockResolvedValue(snapshot);
      mockInsightsService.getRefreshState.mockResolvedValue(idleRefreshState);

      const result = await controller.getLatest();

      expect(result.status).toBe('ready');
      expect(result.metrics).toEqual(snapshot.metrics);
      expect(result.computedAt).toBe(snapshot.computedAt.toISOString());
      expect(result.durationMs).toBe(snapshot.durationMs);
    });

    it('includes the refresh state in the response', async () => {
      mockInsightsService.getLatest.mockResolvedValue(makeReadySnapshot());
      mockInsightsService.getRefreshState.mockResolvedValue(pendingRefreshState);

      const result = await controller.getLatest();

      expect(result.refresh).toEqual(pendingRefreshState);
    });

    it('delegates to insightsService.getLatest() and getRefreshState()', async () => {
      mockInsightsService.getLatest.mockResolvedValue(makeReadySnapshot());
      mockInsightsService.getRefreshState.mockResolvedValue(idleRefreshState);

      await controller.getLatest();

      expect(mockInsightsService.getLatest).toHaveBeenCalledTimes(1);
      expect(mockInsightsService.getRefreshState).toHaveBeenCalledTimes(1);
    });

    it('returns empty state when service returns null (no snapshot)', async () => {
      mockInsightsService.getLatest.mockResolvedValue(null);
      mockInsightsService.getRefreshState.mockResolvedValue(idleRefreshState);

      const result = await controller.getLatest();

      expect(result.status).toBe('empty');
      expect(result.metrics).toBeNull();
      expect(result.computedAt).toBeNull();
      expect(result.durationMs).toBeNull();
      expect(result.refresh).toEqual(idleRefreshState);
    });

    it('serialises computedAt as an ISO string', async () => {
      const snapshot = makeReadySnapshot();
      mockInsightsService.getLatest.mockResolvedValue(snapshot);
      mockInsightsService.getRefreshState.mockResolvedValue(idleRefreshState);

      const result = await controller.getLatest();

      expect(result.computedAt).toBe('2025-06-20T10:00:00.000Z');
    });

    it('returns null computedAt when snapshot.computedAt is null', async () => {
      const snapshot = makeReadySnapshot();
      (snapshot as any).computedAt = null;
      mockInsightsService.getLatest.mockResolvedValue(snapshot);
      mockInsightsService.getRefreshState.mockResolvedValue(idleRefreshState);

      const result = await controller.getLatest();

      expect(result.computedAt).toBeNull();
    });
  });

  // =========================================================================
  // POST /admin/insights/refresh — refresh
  // =========================================================================

  describe('refresh', () => {
    it('delegates to insightsService.enqueueRefresh() with priority 0', async () => {
      const job = { id: 'job-uuid', status: JobStatus.pending };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      await controller.refresh();

      expect(mockInsightsService.enqueueRefresh).toHaveBeenCalledWith(
        expect.anything(), // JobReason.rerun
        0,                 // highest priority
      );
    });

    it('returns jobId and state from the enqueued job', async () => {
      const job = { id: 'job-uuid-123', status: JobStatus.pending };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      const result = await controller.refresh();

      expect(result).toEqual({ jobId: 'job-uuid-123', state: JobStatus.pending });
    });

    it('returns running state when dedup returns an already-running job', async () => {
      const job = { id: 'job-running', status: JobStatus.running };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      const result = await controller.refresh();

      expect(result.state).toBe(JobStatus.running);
    });

    it('propagates errors thrown by insightsService.enqueueRefresh()', async () => {
      mockInsightsService.enqueueRefresh.mockRejectedValue(new Error('enqueue failed'));

      await expect(controller.refresh()).rejects.toThrow('enqueue failed');
    });
  });

  // =========================================================================
  // @Auth metadata wiring
  // =========================================================================

  describe('@Auth metadata wiring', () => {
    it('getLatest requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.getLatest);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('getLatest requires SYSTEM_SETTINGS_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.getLatest);
      expect(permissions).toContain(PERMISSIONS.SYSTEM_SETTINGS_READ);
    });

    it('refresh requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.refresh);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('refresh requires SYSTEM_SETTINGS_WRITE permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.refresh);
      expect(permissions).toContain(PERMISSIONS.SYSTEM_SETTINGS_WRITE);
    });
  });
});
