import { Reflector } from '@nestjs/core';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import {
  MaintenanceGuard,
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_RETRY_AFTER_SECONDS,
} from './maintenance.guard';
import { MaintenanceModeService, MaintenanceState } from './maintenance-mode.service';
import { ALLOW_DURING_MAINTENANCE_KEY } from './allow-during-maintenance.decorator';
import { MaintenanceController } from './maintenance.controller';
import { HealthController } from '../../health/health.controller';
import { AuthController } from '../../auth/auth.controller';
import { ROLES } from '../constants/roles.constants';

const state = (over: Partial<MaintenanceState> = {}): MaintenanceState => ({
  active: true,
  message: 'Upgrading to v2.4',
  allowAdmins: true,
  startedAt: '2026-08-09T00:00:00.000Z',
  startedById: 'admin-1',
  persistedEnabled: true,
  inMemoryOverride: null,
  envOverride: null,
  ...over,
});

describe('MaintenanceGuard', () => {
  let guard: MaintenanceGuard;
  let reflector: Reflector;
  let maintenance: { getState: jest.Mock };
  let jwtService: { verify: jest.Mock };
  let header: jest.Mock;

  const ctx = (opts: {
    exempt?: boolean;
    authorization?: string;
    user?: unknown;
    type?: string;
  } = {}): ExecutionContext => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key) =>
        key === ALLOW_DURING_MAINTENANCE_KEY ? (opts.exempt ?? false) : undefined,
      );

    return {
      getType: () => opts.type ?? 'http',
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({
          headers: opts.authorization ? { authorization: opts.authorization } : {},
          user: opts.user,
          url: '/api/media',
        }),
        getResponse: () => ({ header }),
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    reflector = new Reflector();
    maintenance = { getState: jest.fn().mockResolvedValue(state()) };
    jwtService = { verify: jest.fn() };
    header = jest.fn();

    guard = new MaintenanceGuard(
      reflector,
      maintenance as unknown as MaintenanceModeService,
      jwtService as unknown as JwtService,
    );
  });

  describe('when maintenance is inactive', () => {
    it('passes everything through', async () => {
      maintenance.getState.mockResolvedValue(state({ active: false }));
      await expect(guard.canActivate(ctx())).resolves.toBe(true);
    });
  });

  describe('when maintenance is active', () => {
    it('blocks a normal route with 503', async () => {
      await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('includes the stable marker, message and startedAt in the body', async () => {
      // The frontend keys off `error === 'maintenance'` to distinguish this
      // from an ordinary upstream 503.
      try {
        await guard.canActivate(ctx());
        throw new Error('expected the guard to throw');
      } catch (err: any) {
        expect(err.getStatus()).toBe(503);
        expect(err.getResponse()).toEqual({
          error: MAINTENANCE_ERROR_MARKER,
          message: 'Upgrading to v2.4',
          startedAt: '2026-08-09T00:00:00.000Z',
        });
      }
    });

    it('sets a Retry-After header', async () => {
      await expect(guard.canActivate(ctx())).rejects.toBeDefined();
      expect(header).toHaveBeenCalledWith(
        'Retry-After',
        String(MAINTENANCE_RETRY_AFTER_SECONDS),
      );
    });

    it('falls back to a generic message when the admin left it blank', async () => {
      maintenance.getState.mockResolvedValue(state({ message: '' }));
      try {
        await guard.canActivate(ctx());
        throw new Error('expected the guard to throw');
      } catch (err: any) {
        expect(err.getResponse().message).toMatch(/maintenance/i);
      }
    });

    it('allows a route marked @AllowDuringMaintenance()', async () => {
      await expect(guard.canActivate(ctx({ exempt: true }))).resolves.toBe(true);
    });

    it('never blocks a non-HTTP execution context', async () => {
      await expect(guard.canActivate(ctx({ type: 'rpc' }))).resolves.toBe(true);
    });
  });

  describe('allowAdmins bypass', () => {
    it('allows an admin JWT when allowAdmins is true', async () => {
      jwtService.verify.mockReturnValue({ roles: [ROLES.ADMIN] });
      await expect(
        guard.canActivate(ctx({ authorization: 'Bearer jwt.token.here' })),
      ).resolves.toBe(true);
    });

    it('BLOCKS an admin JWT when allowAdmins is false', async () => {
      maintenance.getState.mockResolvedValue(state({ allowAdmins: false }));
      jwtService.verify.mockReturnValue({ roles: [ROLES.ADMIN] });

      await expect(
        guard.canActivate(ctx({ authorization: 'Bearer jwt.token.here' })),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('blocks a non-admin JWT even when allowAdmins is true', async () => {
      jwtService.verify.mockReturnValue({ roles: ['viewer'] });
      await expect(
        guard.canActivate(ctx({ authorization: 'Bearer jwt.token.here' })),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('blocks an unauthenticated request', async () => {
      await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(jwtService.verify).not.toHaveBeenCalled();
    });

    it('treats an invalid/expired token as "not an admin" rather than throwing 401', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(
        guard.canActivate(ctx({ authorization: 'Bearer expired.jwt' })),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('never grants the bypass to a PAT or node credential', async () => {
      for (const token of ['pat_abc123', 'nod_abc123']) {
        await expect(
          guard.canActivate(ctx({ authorization: `Bearer ${token}` })),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
      }
      expect(jwtService.verify).not.toHaveBeenCalled();
    });

    it('honors an already-resolved request.user carrying the Admin role', async () => {
      await expect(
        guard.canActivate(
          ctx({ user: { userRoles: [{ role: { name: ROLES.ADMIN } }] } }),
        ),
      ).resolves.toBe(true);
    });
  });

  /**
   * LOCKOUT GUARANTEE (issue #348) — do NOT delete or weaken these.
   *
   * If maintenance mode 503'd every route, an admin could never turn it off
   * again: the toggle endpoint would be behind the very block it exists to
   * lift. These assertions read the real `@AllowDuringMaintenance()` metadata
   * off the shipped controllers, so removing the decorator in a future
   * refactor fails here instead of silently bricking recovery in production.
   */
  describe('lockout-prevention regression', () => {
    const realReflector = new Reflector();

    const isExempt = (controller: Function, method?: string) =>
      realReflector.getAllAndOverride<boolean>(ALLOW_DURING_MAINTENANCE_KEY, [
        method ? (controller.prototype as any)[method] : controller,
        controller,
      ]) === true;

    it('the maintenance toggle endpoints themselves stay reachable while active', () => {
      expect(isExempt(MaintenanceController, 'getState')).toBe(true);
      expect(isExempt(MaintenanceController, 'setState')).toBe(true);
    });

    it('the guard actually lets an exempt-marked handler through while active', async () => {
      // Belt and braces: the metadata above is only useful if the guard reads
      // it, so assert the end-to-end behavior too.
      maintenance.getState.mockResolvedValue(state({ allowAdmins: false }));
      await expect(guard.canActivate(ctx({ exempt: true }))).resolves.toBe(true);
    });

    it('health probes stay reachable', () => {
      expect(isExempt(HealthController, 'liveness')).toBe(true);
      expect(isExempt(HealthController, 'readiness')).toBe(true);
    });

    it('the sign-in auth routes stay reachable', () => {
      for (const method of [
        'getProviders',
        'googleAuth',
        'googleAuthCallback',
        'refresh',
        'getCurrentUser',
      ]) {
        expect((AuthController.prototype as any)[method]).toBeDefined();
        expect(isExempt(AuthController, method)).toBe(true);
      }
    });
  });
});
