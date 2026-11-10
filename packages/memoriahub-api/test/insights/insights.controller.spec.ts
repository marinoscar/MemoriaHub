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
const MhLegacyJobStatus = { pending: 'pending', running: 'running' } as const;
import { MemoriahubAuthGuard } from '../../src/core/index.js';
import { InsightsController } from '../../src/insights/insights.controller.js';
import { InsightsService } from '../../src/insights/insights.service.js';
import { MEMORIAHUB_PERMISSIONS_KEY as PERMISSIONS_KEY, MEMORIAHUB_ROLES_KEY as ROLES_KEY } from '../../src/core/auth/memoriahub-auth.constants.js';

const ROLES = { ADMIN: 'admin' };
const PERMISSIONS = { SYSTEM_SETTINGS_READ: 'system_settings:read', SYSTEM_SETTINGS_WRITE: 'system_settings:write' };

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
      .overrideGuard(MemoriahubAuthGuard)
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
      const job = { id: 'job-uuid', status: MhLegacyJobStatus.pending };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      await controller.refresh();

      expect(mockInsightsService.enqueueRefresh).toHaveBeenCalledWith(
        'rerun',
        0,                 // highest priority
      );
    });

    it('returns jobId and state from the enqueued job', async () => {
      const job = { id: 'job-uuid-123', status: MhLegacyJobStatus.pending };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      const result = await controller.refresh();

      expect(result).toEqual({ jobId: 'job-uuid-123', state: MhLegacyJobStatus.pending });
    });

    it('returns running state when dedup returns an already-running job', async () => {
      const job = { id: 'job-running', status: MhLegacyJobStatus.running };
      mockInsightsService.enqueueRefresh.mockResolvedValue(job);

      const result = await controller.refresh();

      expect(result.state).toBe(MhLegacyJobStatus.running);
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
