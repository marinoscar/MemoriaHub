/**
 * Unit tests for InsightsController.
 *
 * Verifies handler delegation to InsightsService and the DTO shape returned
 * for both ready and empty states.  Also asserts @Auth metadata wiring
 * (role + permission decorators) using the same Reflect approach as the
 * EnrichmentAdminController spec.
 *
 * Auth guards are overridden — RBAC enforcement is covered by integration tests.
 */

import { Test, TestingModule } from '@nestjs/testing';
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
  recompute: jest.fn(),
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

      const result = await controller.getLatest();

      expect(result.status).toBe('ready');
      expect(result.metrics).toEqual(snapshot.metrics);
      expect(result.computedAt).toBe(snapshot.computedAt.toISOString());
      expect(result.durationMs).toBe(snapshot.durationMs);
    });

    it('delegates to insightsService.getLatest()', async () => {
      mockInsightsService.getLatest.mockResolvedValue(makeReadySnapshot());

      await controller.getLatest();

      expect(mockInsightsService.getLatest).toHaveBeenCalledTimes(1);
    });

    it('returns empty state when service returns null (no snapshot)', async () => {
      mockInsightsService.getLatest.mockResolvedValue(null);

      const result = await controller.getLatest();

      expect(result).toEqual({
        status: 'empty',
        metrics: null,
        computedAt: null,
        durationMs: null,
      });
    });

    it('serialises computedAt as an ISO string', async () => {
      const snapshot = makeReadySnapshot();
      mockInsightsService.getLatest.mockResolvedValue(snapshot);

      const result = await controller.getLatest();

      expect(result.computedAt).toBe('2025-06-20T10:00:00.000Z');
    });

    it('returns null computedAt when snapshot.computedAt is null', async () => {
      const snapshot = makeReadySnapshot();
      (snapshot as any).computedAt = null;
      mockInsightsService.getLatest.mockResolvedValue(snapshot);

      const result = await controller.getLatest();

      expect(result.computedAt).toBeNull();
    });
  });

  // =========================================================================
  // POST /admin/insights/refresh — refresh
  // =========================================================================

  describe('refresh', () => {
    it('delegates to insightsService.recompute()', async () => {
      mockInsightsService.recompute.mockResolvedValue(makeReadySnapshot());

      await controller.refresh();

      expect(mockInsightsService.recompute).toHaveBeenCalledTimes(1);
    });

    it('returns ready status with metrics from the freshly computed snapshot', async () => {
      const snapshot = makeReadySnapshot();
      mockInsightsService.recompute.mockResolvedValue(snapshot);

      const result = await controller.refresh();

      expect(result.status).toBe('ready');
      expect(result.metrics).toEqual(snapshot.metrics);
      expect(result.computedAt).toBe(snapshot.computedAt.toISOString());
      expect(result.durationMs).toBe(snapshot.durationMs);
    });

    it('propagates errors thrown by insightsService.recompute()', async () => {
      mockInsightsService.recompute.mockRejectedValue(new Error('compute failed'));

      await expect(controller.refresh()).rejects.toThrow('compute failed');
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
