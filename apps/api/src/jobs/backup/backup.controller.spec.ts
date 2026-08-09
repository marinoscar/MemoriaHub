import { Test, TestingModule } from '@nestjs/testing';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { TriggerBackupDto } from './dto/trigger-backup.dto';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Unit tests for BackupController.
 * Auth guards are NOT mocked here — we test handler method delegation only,
 * not the HTTP layer. Guards are tested in integration tests.
 */
describe('BackupController', () => {
  let controller: BackupController;
  let mockBackupService: {
    runBackup: jest.Mock;
    getRecentRuns: jest.Mock;
    getRunStatus: jest.Mock;
  };

  const mockUser: RequestUser = {
    id: 'user-test-id',
    email: 'admin@example.com',
    roles: ['Admin'],
    permissions: ['backup:run', 'backup:read'],
    isActive: true,
  };

  const mockRunResult = {
    runId: 'run-abc-123',
    scope: 'all',
    copied: 5,
    skipped: 1,
    failed: 0,
    errors: [],
  };

  beforeEach(async () => {
    mockBackupService = {
      runBackup: jest.fn().mockResolvedValue(mockRunResult),
      getRecentRuns: jest.fn().mockResolvedValue([]),
      getRunStatus: jest.fn().mockResolvedValue({ runId: 'run-abc-123', status: 'completed' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        { provide: BackupService, useValue: mockBackupService },
      ],
    })
      // Override guards to allow testing without auth infrastructure
      .overrideGuard(require('../../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BackupController>(BackupController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('triggerBackup() — POST /admin/backup', () => {
    it('calls backupService.runBackup() with the dto and user ID', async () => {
      const dto: TriggerBackupDto = { all: true };

      const result = await controller.triggerBackup(dto, mockUser);

      expect(mockBackupService.runBackup).toHaveBeenCalledWith(dto, mockUser.id);
      expect(result).toEqual(mockRunResult);
    });

    it('passes circleId dto through correctly', async () => {
      const dto: TriggerBackupDto = { circleId: 'circle-42' };

      await controller.triggerBackup(dto, mockUser);

      expect(mockBackupService.runBackup).toHaveBeenCalledWith(dto, mockUser.id);
    });

    it('returns the service result unchanged', async () => {
      const dto: TriggerBackupDto = { all: true };
      const customResult = { runId: 'custom-run', scope: 'all', copied: 10, skipped: 0, failed: 0, errors: [] };
      mockBackupService.runBackup.mockResolvedValue(customResult);

      const result = await controller.triggerBackup(dto, mockUser);

      expect(result).toBe(customResult);
    });
  });

  describe('listRuns() — GET /admin/backup/runs', () => {
    it('calls backupService.getRecentRuns() with default limit 20 when no query param', async () => {
      await controller.listRuns(undefined);

      expect(mockBackupService.getRecentRuns).toHaveBeenCalledWith(20);
    });

    it('calls backupService.getRecentRuns() with parsed numeric limit', async () => {
      await controller.listRuns('5');

      expect(mockBackupService.getRecentRuns).toHaveBeenCalledWith(5);
    });

    it('returns the service result', async () => {
      const fakeRuns = [{ runId: 'r1', scope: 'all', copied: 2, skipped: 0, failed: 0 }];
      mockBackupService.getRecentRuns.mockResolvedValue(fakeRuns);

      const result = await controller.listRuns(undefined);

      expect(result).toBe(fakeRuns);
    });
  });

  describe('getRunStatus() — GET /admin/backup/runs/:runId', () => {
    it('calls backupService.getRunStatus() with the runId param', async () => {
      const runId = 'run-xyz-999';

      const result = await controller.getRunStatus(runId);

      expect(mockBackupService.getRunStatus).toHaveBeenCalledWith(runId);
      expect(result).toEqual({ runId: 'run-abc-123', status: 'completed' });
    });

    it('returns the service result for the given runId', async () => {
      const statusResult = { runId: 'run-xyz', status: 'started' as const };
      mockBackupService.getRunStatus.mockResolvedValue(statusResult);

      const result = await controller.getRunStatus('run-xyz');

      expect(result).toBe(statusResult);
    });
  });
});
