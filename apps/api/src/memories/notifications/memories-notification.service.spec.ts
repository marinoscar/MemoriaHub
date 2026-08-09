/**
 * Unit tests for MemoriesNotificationService (epic #300, issue #311).
 *
 * The load-bearing behaviours here are the ones the notification design exists
 * to guarantee: a batch of N memories is ONE counted row per member (never N),
 * every member is a recipient regardless of per-circle role, and nothing this
 * producer does can ever throw into the generation job that called it.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MemoryType, NotificationType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  MEMORIES_READY_LINK,
  MEMORIES_READY_WINDOW_MS,
  MemoriesNotificationService,
} from './memories-notification.service';

type UpsertArg = Parameters<NotificationsService['upsertCountedEvent']>[0];

describe('MemoriesNotificationService', () => {
  let service: MemoriesNotificationService;
  let prisma: {
    circle: { findUnique: jest.Mock };
    memory: { findMany: jest.Mock };
  };
  let notifications: {
    upsertCountedEvent: jest.Mock;
    primePreferences: jest.Mock;
  };

  const SINCE = new Date('2026-08-09T06:00:00.000Z');

  beforeEach(async () => {
    prisma = {
      circle: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Familia',
          members: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }],
        }),
      },
      memory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    notifications = {
      upsertCountedEvent: jest.fn().mockResolvedValue(undefined),
      primePreferences: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoriesNotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(MemoriesNotificationService);
  });

  function args(index = 0): UpsertArg {
    return notifications.upsertCountedEvent.mock.calls[index]![0] as UpsertArg;
  }

  it('writes ONE counted row per member for a batch of memories', async () => {
    const result = await service.recordGenerated({
      circleId: 'circle-a',
      createdCount: 6,
      since: SINCE,
    });

    expect(result).toEqual({ recipients: 3, skipped: false });
    // Three members ⇒ three calls; the SIX memories fold into each member's
    // single row via `increment`, they do not fan out into six calls.
    expect(notifications.upsertCountedEvent).toHaveBeenCalledTimes(3);
    expect(args().increment).toBe(6);
    expect(args().type).toBe(NotificationType.memories_ready);
    expect(args().windowMs).toBe(MEMORIES_READY_WINDOW_MS);
    expect(args().link).toBe(MEMORIES_READY_LINK);
    expect(args().reunreadOnIncrement).toBe(true);
    expect(new Set(notifications.upsertCountedEvent.mock.calls.map((c) => c[0].userId))).toEqual(
      new Set(['u1', 'u2', 'u3']),
    );
  });

  it('partitions by circle: matchData is mirrored in data', async () => {
    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    // Every matchData key MUST also appear in `data`, or the row this call
    // creates would not be found (and incremented) by the next one.
    expect(args().matchData).toEqual({ circleId: 'circle-a' });
    expect(args().data).toMatchObject({ circleId: 'circle-a' });
    expect(args().circleId).toBe('circle-a');
  });

  it('pluralizes the title against the RESULTING count, not the increment', async () => {
    await service.recordGenerated({ circleId: 'circle-a', createdCount: 1, since: SINCE });

    expect(args().buildTitle(1)).toBe('1 new memory in Familia');
    expect(args().buildTitle(7)).toBe('7 new memories in Familia');
  });

  it('uses today-anchored on_this_day as the body when the run produced one', async () => {
    prisma.memory.findMany.mockResolvedValue([
      { title: 'Summer 2025', type: MemoryType.seasonal },
      { title: 'On this day — 6 years ago', type: MemoryType.on_this_day },
    ]);

    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    expect(args().body).toBe('On this day — 6 years ago');
    // Only THIS run's memories are considered.
    expect(prisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          circleId: 'circle-a',
          deletedAt: null,
          generatedAt: { gte: SINCE },
        }),
      }),
    );
  });

  it('falls back to the newest memory when the run produced no on_this_day', async () => {
    prisma.memory.findMany.mockResolvedValue([
      { title: 'Trip to Guanacaste', type: MemoryType.trip },
      { title: 'Golden sunsets', type: MemoryType.theme },
    ]);

    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    expect(args().body).toBe('Trip to Guanacaste');
  });

  it('still notifies when the title lookup fails — the row just has no body', async () => {
    prisma.memory.findMany.mockRejectedValue(new Error('db down'));

    await service.recordGenerated({ circleId: 'circle-a', createdCount: 3, since: SINCE });

    expect(notifications.upsertCountedEvent).toHaveBeenCalledTimes(3);
    expect(args().body).toBeNull();
  });

  it('warms preferences once for the whole membership', async () => {
    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    expect(notifications.primePreferences).toHaveBeenCalledTimes(1);
    expect(notifications.primePreferences).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
  });

  it('produces nothing when the run created nothing', async () => {
    const result = await service.recordGenerated({
      circleId: 'circle-a',
      createdCount: 0,
      since: SINCE,
    });

    expect(result).toEqual({ recipients: 0, skipped: true });
    expect(prisma.circle.findUnique).not.toHaveBeenCalled();
    expect(notifications.upsertCountedEvent).not.toHaveBeenCalled();
  });

  it('produces nothing when the circle was deleted mid-run', async () => {
    prisma.circle.findUnique.mockResolvedValue(null);

    const result = await service.recordGenerated({
      circleId: 'circle-a',
      createdCount: 4,
      since: SINCE,
    });

    expect(result).toEqual({ recipients: 0, skipped: true });
    expect(notifications.upsertCountedEvent).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: recordGeneratedAsync never rejects', async () => {
    prisma.circle.findUnique.mockRejectedValue(new Error('db down'));

    expect(() =>
      service.recordGeneratedAsync({ circleId: 'circle-a', createdCount: 2, since: SINCE }),
    ).not.toThrow();

    // Let the swallowed rejection settle; an unhandled rejection here would
    // fail the suite, which is exactly the regression this guards.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
