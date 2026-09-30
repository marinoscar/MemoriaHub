import { Test, TestingModule } from '@nestjs/testing';

import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationPolicyService } from '../../notifications/notification-policy.service';
import { NotificationsService } from '../../notifications/notifications.service';
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
  let notifications: { dismissTypesGlobally: jest.Mock; invalidateAllUnreadCounts: jest.Mock };

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
    notifications = {
      dismissTypesGlobally: jest.fn().mockResolvedValue(2),
      invalidateAllUnreadCounts: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationPolicyService, useValue: policy },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(SystemSettingsService);

    mockPrisma.systemSettings.findUnique.mockResolvedValue(storedRow() as any);
    mockPrisma.systemSettings.update.mockResolvedValue(storedRow() as any);
    mockPrisma.systemSettings.upsert.mockResolvedValue(storedRow() as any);
    mockPrisma.auditEvent.create.mockResolvedValue({} as any);
    // Interactive-transaction passthrough: `cb(tx)` runs against the same mock.
    (mockPrisma.$transaction as jest.Mock).mockImplementation((cb: any) => cb(mockPrisma));
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

  describe('admin dismiss-on-disable', () => {
    it('dismisses newly disabled types app-wide inside the settings transaction', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        storedRow({ disabledTypes: ['upload_completed'] }) as any,
      );

      await service.patchSettings(
        {
          notifications: {
            disabledTypes: ['upload_completed', 'review_queue_bursts', 'admin_broadcast_critical'],
          },
        } as any,
        userId,
      );

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Only the NEWLY disabled, non-mandatory type.
      expect(notifications.dismissTypesGlobally).toHaveBeenCalledTimes(1);
      const [types, tx] = notifications.dismissTypesGlobally.mock.calls[0];
      expect(types).toEqual(['review_queue_bursts']);
      expect(tx).toBeDefined();
      // Settings write first, then dismissal, then cache drop after commit.
      expect(mockPrisma.systemSettings.update.mock.invocationCallOrder[0]).toBeLessThan(
        notifications.dismissTypesGlobally.mock.invocationCallOrder[0],
      );
      expect(notifications.invalidateAllUnreadCounts).toHaveBeenCalledTimes(1);
    });

    it('opens no transaction and dismisses nothing when no type is newly disabled', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        storedRow({ disabledTypes: ['upload_completed', 'review_queue_bursts'] }) as any,
      );

      await service.patchSettings(
        { notifications: { disabledTypes: ['review_queue_bursts'] } } as any,
        userId,
      );
      await service.patchSettings({ ui: { allowUserThemeOverride: false } } as any, userId);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(notifications.dismissTypesGlobally).not.toHaveBeenCalled();
      expect(notifications.invalidateAllUnreadCounts).not.toHaveBeenCalled();
    });

    it('does not dismiss when only a mandatory type is added', async () => {
      await service.patchSettings(
        { notifications: { disabledTypes: ['admin_broadcast_critical'] } } as any,
        userId,
      );
      expect(notifications.dismissTypesGlobally).not.toHaveBeenCalled();
    });

    it('also dismisses on a PUT that newly disables a type', async () => {
      await service.replaceSettings(
        {
          ...(DEFAULT_SYSTEM_SETTINGS as any),
          notifications: {
            ...(DEFAULT_SYSTEM_SETTINGS as any).notifications,
            disabledTypes: ['review_queue_duplicates'],
          },
        },
        userId,
      );

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(notifications.dismissTypesGlobally.mock.calls[0][0]).toEqual([
        'review_queue_duplicates',
      ]);
      expect(notifications.invalidateAllUnreadCounts).toHaveBeenCalledTimes(1);
    });

    it('rolls back together: a failed dismissal fails the write and drops no caches', async () => {
      notifications.dismissTypesGlobally.mockRejectedValue(new Error('lock timeout'));

      await expect(
        service.patchSettings(
          { notifications: { disabledTypes: ['review_queue_bursts'] } } as any,
          userId,
        ),
      ).rejects.toThrow('lock timeout');
      expect(notifications.invalidateAllUnreadCounts).not.toHaveBeenCalled();
      expect(policy.invalidate).not.toHaveBeenCalled();
    });
  });
});
