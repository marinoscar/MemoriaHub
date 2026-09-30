/**
 * NotificationsService.dismissTypesGlobally() / invalidateAllUnreadCounts()
 * (issue #489): the app-wide dismissal behind an admin adding a type to
 * `notifications.disabledTypes`.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { GLOBAL_DISMISS_BATCH_SIZE, NotificationsService } from './notifications.service';

describe('NotificationsService.dismissTypesGlobally (#489)', () => {
  let service: NotificationsService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: NotificationPreferencesService,
          useValue: { isEnabled: jest.fn().mockResolvedValue(true), invalidate: jest.fn() },
        },
        {
          provide: NotificationPolicyService,
          useValue: { isInboxAllowed: jest.fn().mockResolvedValue(true) },
        },
        { provide: NotificationDispatchService, useValue: { dispatch: jest.fn() } },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  afterEach(() => jest.restoreAllMocks());

  const rawCalls = () => (mockPrisma.$executeRaw as jest.Mock).mock.calls;

  it('is a no-op for an empty list', async () => {
    await expect(service.dismissTypesGlobally([])).resolves.toBe(0);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('never dismisses mandatory types', async () => {
    await expect(
      service.dismissTypesGlobally(['admin_broadcast_critical' as NotificationType]),
    ).resolves.toBe(0);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('dismisses live rows of the listed types for every user, implying read', async () => {
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValueOnce(3);

    const n = await service.dismissTypesGlobally([
      'review_queue_bursts',
      'admin_broadcast_critical' as NotificationType,
      'review_queue_bursts',
    ]);

    expect(n).toBe(3);
    expect(rawCalls()).toHaveLength(1);
    const sql = rawCalls()[0][0] as Prisma.Sql;
    expect(sql.sql).toContain('dismissed_at = now()');
    expect(sql.sql).toContain('read_at = COALESCE(read_at, now())');
    expect(sql.sql).toContain('updated_at = now()');
    expect(sql.sql).toContain('dismissed_at IS NULL');
    expect(sql.sql).toContain('LIMIT');
    // App-wide: no user scope.
    expect(sql.sql).not.toContain('user_id');
    // Deduped, mandatory type filtered out.
    expect(sql.values).toContainEqual(['review_queue_bursts']);
    expect(sql.values).toContain(GLOBAL_DISMISS_BATCH_SIZE);
  });

  it('loops in bounded batches until a short batch', async () => {
    (mockPrisma.$executeRaw as jest.Mock)
      .mockResolvedValueOnce(GLOBAL_DISMISS_BATCH_SIZE)
      .mockResolvedValueOnce(GLOBAL_DISMISS_BATCH_SIZE)
      .mockResolvedValueOnce(7);

    await expect(service.dismissTypesGlobally(['upload_completed'])).resolves.toBe(
      GLOBAL_DISMISS_BATCH_SIZE * 2 + 7,
    );
    expect(rawCalls()).toHaveLength(3);
  });

  it('runs on the supplied transaction client', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
    await service.dismissTypesGlobally(['upload_completed'], tx as any);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('invalidateAllUnreadCounts() drops every cached badge count', async () => {
    (mockPrisma.notification.count as jest.Mock).mockResolvedValue(4);
    await service.getUnreadCount('u1');
    await service.getUnreadCount('u2');
    expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2);

    await service.getUnreadCount('u1');
    expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2); // cached

    service.invalidateAllUnreadCounts();
    await service.getUnreadCount('u1');
    await service.getUnreadCount('u2');
    expect(mockPrisma.notification.count).toHaveBeenCalledTimes(4);
  });
});
