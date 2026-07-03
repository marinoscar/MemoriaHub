/**
 * Unit tests for DoctorController.
 *
 * Verifies handler delegation to DoctorService.runDiagnostics() and the
 * @Auth metadata wiring (Admin role + system_settings:read permission).
 * RBAC enforcement itself is covered by integration tests — this is a
 * delegation + decorator-wiring test only.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';
import { DoctorReport } from './doctor.types';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';

// ---------------------------------------------------------------------------
// Mock DoctorService
// ---------------------------------------------------------------------------

const mockDoctorService = {
  runDiagnostics: jest.fn(),
};

function makeReport(): DoctorReport {
  return {
    computedAt: '2026-07-03T00:00:00.000Z',
    durationMs: 42,
    summary: { ok: 20, warning: 0, error: 0, skipped: 0, total: 20 },
    sections: [
      { key: 'core', label: 'Core', status: 'ok', checks: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DoctorController', () => {
  let controller: DoctorController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DoctorController],
      providers: [{ provide: DoctorService, useValue: mockDoctorService }],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DoctorController>(DoctorController);
  });

  // =========================================================================
  // POST /admin/doctor/run — runDiagnostics
  // =========================================================================

  describe('runDiagnostics', () => {
    it('delegates to doctorService.runDiagnostics()', async () => {
      const report = makeReport();
      mockDoctorService.runDiagnostics.mockResolvedValue(report);

      await controller.runDiagnostics();

      expect(mockDoctorService.runDiagnostics).toHaveBeenCalledTimes(1);
    });

    it('returns the report produced by the service unchanged', async () => {
      const report = makeReport();
      mockDoctorService.runDiagnostics.mockResolvedValue(report);

      const result = await controller.runDiagnostics();

      expect(result).toEqual(report);
    });

    it('propagates errors thrown by doctorService.runDiagnostics()', async () => {
      mockDoctorService.runDiagnostics.mockRejectedValue(new Error('boom'));

      await expect(controller.runDiagnostics()).rejects.toThrow('boom');
    });
  });

  // =========================================================================
  // @Auth metadata wiring
  // =========================================================================

  describe('@Auth metadata wiring', () => {
    it('requires ADMIN role', () => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, controller.runDiagnostics);
      expect(roles).toContain(ROLES.ADMIN);
    });

    it('requires SYSTEM_SETTINGS_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, controller.runDiagnostics);
      expect(permissions).toContain(PERMISSIONS.SYSTEM_SETTINGS_READ);
    });
  });
});
