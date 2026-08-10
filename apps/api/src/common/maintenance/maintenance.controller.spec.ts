import { Test, TestingModule } from '@nestjs/testing';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceModeService, MaintenanceState } from './maintenance-mode.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';

const state = (over: Partial<MaintenanceState> = {}): MaintenanceState => ({
  active: false,
  message: '',
  allowAdmins: true,
  startedAt: null,
  startedById: null,
  persistedEnabled: false,
  inMemoryOverride: null,
  envOverride: null,
  ...over,
});

describe('MaintenanceController', () => {
  let controller: MaintenanceController;
  let service: { getState: jest.Mock; setState: jest.Mock };

  beforeEach(async () => {
    service = {
      getState: jest.fn().mockResolvedValue(state()),
      setState: jest.fn().mockResolvedValue(state({ active: true })),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MaintenanceController],
      providers: [{ provide: MaintenanceModeService, useValue: service }],
    })
      // The controller's @Auth() decorator applies JwtAuthGuard, RolesGuard,
      // and PermissionsGuard; all three are stubbed here because this spec
      // covers only the controller-to-service contract, not authorization.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MaintenanceController);
  });

  it('GET returns the full resolved state, including each contributing layer', async () => {
    service.getState.mockResolvedValue(
      state({ active: true, envOverride: true, persistedEnabled: false }),
    );

    await expect(controller.getState()).resolves.toMatchObject({
      active: true,
      envOverride: true,
      persistedEnabled: false,
    });
  });

  it('PUT forwards the toggle and the acting user id to the service', async () => {
    await controller.setState(
      { enabled: true, message: 'Upgrading', allowAdmins: false } as any,
      'admin-1',
    );

    expect(service.setState).toHaveBeenCalledWith(
      { enabled: true, message: 'Upgrading', allowAdmins: false },
      'admin-1',
    );
  });

  it('PUT returns the resulting state', async () => {
    await expect(
      controller.setState({ enabled: true } as any, 'admin-1'),
    ).resolves.toMatchObject({ active: true });
  });
});
