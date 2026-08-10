import { Test, TestingModule } from '@nestjs/testing';
import { MaintenanceModeService } from './maintenance-mode.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Issue #348. The three layers under test — env override, in-memory
 * override, persisted setting — and the precedence between them are the whole
 * lockout-safety story; see maintenance.guard.spec.ts for the guard half.
 */
describe('MaintenanceModeService', () => {
  let service: MaintenanceModeService;
  let systemSettings: {
    getSettings: jest.Mock;
    patchSettings: jest.Mock;
    invalidateSettingsCache: jest.Mock;
  };
  let prisma: { auditEvent: { create: jest.Mock } };

  const ENV_KEY = 'MAINTENANCE_MODE';
  const originalEnv = process.env[ENV_KEY];

  const persisted = (over: Record<string, unknown> = {}) => ({
    maintenance: {
      enabled: false,
      message: '',
      allowAdmins: true,
      startedAt: null,
      startedById: null,
      ...over,
    },
  });

  beforeEach(async () => {
    delete process.env[ENV_KEY];

    systemSettings = {
      getSettings: jest.fn().mockResolvedValue(persisted()),
      patchSettings: jest.fn().mockResolvedValue({}),
      invalidateSettingsCache: jest.fn(),
    };
    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MaintenanceModeService,
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(MaintenanceModeService);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  describe('persisted layer', () => {
    it('is inactive when the persisted flag is false', async () => {
      await expect(service.isActive()).resolves.toBe(false);
    });

    it('is active when the persisted flag is true', async () => {
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('falls back to defaults (inactive) when the settings read throws', async () => {
      // Failing OPEN matters: a settings hiccup must not brick the app.
      systemSettings.getSettings.mockRejectedValue(new Error('db down'));
      await expect(service.isActive()).resolves.toBe(false);
    });

    it('surfaces message/allowAdmins/startedAt from the persisted namespace', async () => {
      systemSettings.getSettings.mockResolvedValue(
        persisted({
          enabled: true,
          message: 'Upgrading to v2.4',
          allowAdmins: false,
          startedAt: '2026-08-09T00:00:00.000Z',
          startedById: 'user-1',
        }),
      );

      await expect(service.getState()).resolves.toMatchObject({
        active: true,
        message: 'Upgrading to v2.4',
        allowAdmins: false,
        startedAt: '2026-08-09T00:00:00.000Z',
        startedById: 'user-1',
        persistedEnabled: true,
      });
    });
  });

  describe('in-memory override', () => {
    it('takes precedence over a persisted false', async () => {
      await service.enable('swap window', 'user-1');
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('takes precedence over a persisted true', async () => {
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));
      await service.disable();
      await expect(service.isActive()).resolves.toBe(false);
    });

    it('clearInMemoryOverride() hands control back to the persisted value', async () => {
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));

      await service.disable();
      await expect(service.isActive()).resolves.toBe(false);

      service.clearInMemoryOverride();
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('enable() records reason/startedAt/startedById in the reported state', async () => {
      const state = await service.enable('DB rename', 'user-9');

      expect(state).toMatchObject({
        active: true,
        message: 'DB rename',
        startedById: 'user-9',
        inMemoryOverride: true,
      });
      expect(state.startedAt).toEqual(expect.any(String));
    });
  });

  describe('MAINTENANCE_MODE env override', () => {
    it('true forces maintenance ON over a persisted false', async () => {
      process.env[ENV_KEY] = 'true';
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('false forces maintenance OFF over a persisted true (break-glass)', async () => {
      // This is the documented recovery from a bad allowAdmins:false lockout.
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));
      process.env[ENV_KEY] = 'false';
      await expect(service.isActive()).resolves.toBe(false);
    });

    it('false also beats an in-memory enable', async () => {
      await service.enable('whatever', 'user-1');
      process.env[ENV_KEY] = 'false';
      await expect(service.isActive()).resolves.toBe(false);
    });

    it('true also beats an in-memory disable', async () => {
      await service.disable();
      process.env[ENV_KEY] = 'true';
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('an unrecognized value is treated as "no override"', async () => {
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));
      process.env[ENV_KEY] = 'maybe';
      await expect(service.isActive()).resolves.toBe(true);
      await expect(service.getState()).resolves.toMatchObject({ envOverride: null });
    });

    it('reports the env layer in getState()', async () => {
      process.env[ENV_KEY] = 'TRUE';
      await expect(service.getState()).resolves.toMatchObject({
        active: true,
        envOverride: true,
        persistedEnabled: false,
      });
    });
  });

  describe('setState()', () => {
    it('persists the namespace, invalidates the cache and audits an enable', async () => {
      await service.setState(
        { enabled: true, message: 'Upgrading', allowAdmins: false },
        'admin-1',
      );

      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          maintenance: expect.objectContaining({
            enabled: true,
            message: 'Upgrading',
            allowAdmins: false,
            startedById: 'admin-1',
          }),
        }),
        'admin-1',
      );
      expect(systemSettings.invalidateSettingsCache).toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'maintenance:enabled',
            actorUserId: 'admin-1',
            targetType: 'system_settings',
          }),
        }),
      );
    });

    it('clears startedAt/startedById and audits a disable', async () => {
      systemSettings.getSettings.mockResolvedValue(
        persisted({ enabled: true, startedAt: '2026-08-09T00:00:00.000Z', startedById: 'a' }),
      );

      await service.setState({ enabled: false }, 'admin-1');

      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          maintenance: expect.objectContaining({
            enabled: false,
            startedAt: null,
            startedById: null,
          }),
        }),
        'admin-1',
      );
      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'maintenance:disabled' }),
        }),
      );
    });

    it('drops the in-memory override after a successful write', async () => {
      await service.setState({ enabled: true }, 'admin-1');
      await expect(service.getState()).resolves.toMatchObject({
        inMemoryOverride: null,
      });
    });

    it('keeps the site DOWN when persisting an enable fails', async () => {
      systemSettings.patchSettings.mockRejectedValue(new Error('write failed'));

      await expect(
        service.setState({ enabled: true, message: 'x' }, 'admin-1'),
      ).rejects.toThrow('write failed');

      // The in-memory override was set BEFORE the write, so the block is in
      // force even though nothing was persisted — the safe direction.
      await expect(service.isActive()).resolves.toBe(true);
    });

    it('does not half-open the site when persisting a disable fails', async () => {
      systemSettings.getSettings.mockResolvedValue(persisted({ enabled: true }));
      systemSettings.patchSettings.mockRejectedValue(new Error('write failed'));

      await expect(service.setState({ enabled: false }, 'admin-1')).rejects.toThrow(
        'write failed',
      );

      await expect(service.isActive()).resolves.toBe(true);
    });

    it('preserves an existing startedAt across a re-enable', async () => {
      systemSettings.getSettings.mockResolvedValue(
        persisted({ enabled: true, startedAt: '2026-01-01T00:00:00.000Z' }),
      );

      await service.setState({ enabled: true, message: 'edited' }, 'admin-1');

      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          maintenance: expect.objectContaining({
            startedAt: '2026-01-01T00:00:00.000Z',
          }),
        }),
        'admin-1',
      );
    });

    it('a failing audit write never undoes a landed toggle', async () => {
      prisma.auditEvent.create.mockRejectedValue(new Error('audit down'));

      await expect(service.setState({ enabled: true }, 'admin-1')).resolves.toBeDefined();
      expect(systemSettings.patchSettings).toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalled();
    });
  });
});
