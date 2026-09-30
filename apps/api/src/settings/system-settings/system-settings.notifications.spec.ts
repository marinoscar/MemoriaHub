import { Test, TestingModule } from '@nestjs/testing';

import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationPolicyService } from '../../notifications/notification-policy.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';

// Issue #489: SystemSettingsService keeps the notification channel layer in
// step with admin kill-switch writes.

describe('SystemSettingsService — notification policy hardening (#489)', () => {
  let service: SystemSettingsService;
  let mockPrisma: MockPrismaService;
  let policy: { invalidate: jest.Mock };

  const userId = 'admin-1';

  function storedRow(notifications: Record<string, unknown> = {}) {
    return {
      id: 'settings-1',
      key: 'global',
      value: {
        ...(DEFAULT_SYSTEM_SETTINGS as any),
        notifications: {
          ...(DEFAULT_SYSTEM_SETTINGS as any).notifications,
          ...notifications,
        },
      },
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: userId,
      updatedByUser: { id: userId, email: 'a@example.com' },
    };
  }

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    policy = { invalidate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationPolicyService, useValue: policy },
      ],
    }).compile();

    service = module.get(SystemSettingsService);

    mockPrisma.systemSettings.findUnique.mockResolvedValue(storedRow() as any);
    mockPrisma.systemSettings.update.mockResolvedValue(storedRow() as any);
    mockPrisma.systemSettings.upsert.mockResolvedValue(storedRow() as any);
    mockPrisma.auditEvent.create.mockResolvedValue({} as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe('policy cache invalidation', () => {
    it('drops the notification policy cache after a PATCH', async () => {
      await service.patchSettings({ notifications: { pushEnabled: false } } as any, userId);

      expect(policy.invalidate).toHaveBeenCalled();
      // AFTER the write, never before it.
      expect(policy.invalidate.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
        mockPrisma.systemSettings.update.mock.invocationCallOrder[0],
      );
    });

    it('drops the notification policy cache after a PUT', async () => {
      await service.replaceSettings(DEFAULT_SYSTEM_SETTINGS as any, userId);

      expect(policy.invalidate).toHaveBeenCalled();
      expect(policy.invalidate.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
        mockPrisma.systemSettings.upsert.mock.invocationCallOrder[0],
      );
    });

    it('does not invalidate when the write fails', async () => {
      mockPrisma.systemSettings.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.patchSettings({ notifications: { pushEnabled: false } } as any, userId),
      ).rejects.toThrow('db down');
      expect(policy.invalidate).not.toHaveBeenCalled();
    });

    it('works without a policy service (optional dependency)', async () => {
      const bare = new SystemSettingsService(mockPrisma as unknown as PrismaService);
      await expect(
        bare.patchSettings({ notifications: { pushEnabled: false } } as any, userId),
      ).resolves.toBeDefined();
    });
  });
});
