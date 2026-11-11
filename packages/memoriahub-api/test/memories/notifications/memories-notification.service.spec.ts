/**
 * Unit tests for MemoriesNotificationService (epic #300, issue #311).
 *
 * The load-bearing behaviours here are the ones the notification design exists
 * to guarantee: a batch of N memories is ONE counted row per member (never N),
 * every member is a recipient regardless of per-circle role, and nothing this
 * producer does can ever throw into the generation job that called it.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MemoryType } from '../../../src/memories/data/memories-enums.js';
import { MEMORIAHUB_ACCESS, MEMORIAHUB_NOTIFY, MEMORIAHUB_PRISMA } from '../../../src/ports/index.js';
import {
  MEMORIES_READY_EVENT_KEY,
  MEMORIES_READY_LINK,
  MEMORIES_READY_WINDOW_MS,
  MemoriesNotificationService,
} from '../../../src/memories/notifications/memories-notification.service.js';

/** One recorded `notifyCounted` call. */
interface RecordedCounted {
  eventKey: string;
  userId: string;
  data: Record<string, unknown>;
  options: { scopeId?: string; windowMs?: number; increment?: number; match?: unknown } | undefined;
}

describe('MemoriesNotificationService', () => {
  let service: MemoriesNotificationService;
  let prisma: {
    memory: { findMany: jest.Mock };
  };
  let scopeSummary: jest.Mock;
  let membersOf: jest.Mock;
  let notifyCounted: jest.Mock;

  const SINCE = new Date('2026-08-09T06:00:00.000Z');

  beforeEach(async () => {
    prisma = {
      memory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    scopeSummary = jest.fn().mockResolvedValue({ id: 'circle-a', name: 'Familia', kind: 'group', ownerId: null, createdById: null });
    membersOf = jest.fn().mockResolvedValue([
      { userId: 'u1', role: 'viewer' },
      { userId: 'u2', role: 'editor' },
      { userId: 'u3', role: 'admin' },
    ]);
    notifyCounted = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoriesNotificationService,
        { provide: MEMORIAHUB_PRISMA, useValue: prisma },
        { provide: MEMORIAHUB_ACCESS, useValue: { scopeSummary, membersOf } },
        { provide: MEMORIAHUB_NOTIFY, useValue: { notifyCounted } },
      ],
    }).compile();

    service = module.get(MemoriesNotificationService);
  });

  /** The `notifyCounted` call of the port. */
  function calls(): RecordedCounted[] {
    return (notifyCounted.mock.calls as unknown[][]).map(([eventKey, userId, data, options]) => ({
      eventKey: eventKey as string,
      userId: userId as string,
      data: data as Record<string, unknown>,
      options: options as RecordedCounted['options'],
    }));
  }
  function args(index = 0): RecordedCounted {
    return calls()[index]!;
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
    expect(notifyCounted).toHaveBeenCalledTimes(3);
    expect(args().options?.increment).toBe(6);
    expect(args().eventKey).toBe('memories.ready');
    expect(args().eventKey).toBe(MEMORIES_READY_EVENT_KEY);
    expect(args().options?.windowMs).toBe(MEMORIES_READY_WINDOW_MS);
    expect(MEMORIES_READY_LINK).toBe('/memories');
    expect(new Set(calls().map((c) => c.userId))).toEqual(new Set(['u1', 'u2', 'u3']));
  });

  it('partitions by circle: the counted scope is the circle', async () => {
    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    expect(args().options?.scopeId).toBe('circle-a');
    expect(args().options?.match).toBeUndefined();
    expect(args().data).toMatchObject({ circleId: 'circle-a', circleName: 'Familia' });
  });

  it('uses today-anchored on_this_day as the body when the run produced one', async () => {
    prisma.memory.findMany.mockResolvedValue([
      { title: 'Summer 2025', type: MemoryType.seasonal },
      { title: 'On this day — 6 years ago', type: MemoryType.on_this_day },
    ]);

    await service.recordGenerated({ circleId: 'circle-a', createdCount: 2, since: SINCE });

    expect(args().data['topTitle']).toBe('On this day — 6 years ago');
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

    expect(args().data['topTitle']).toBe('Trip to Guanacaste');
  });

  it('still notifies when the title lookup fails — the row just has no body', async () => {
    prisma.memory.findMany.mockRejectedValue(new Error('db down'));

    await service.recordGenerated({ circleId: 'circle-a', createdCount: 3, since: SINCE });

    expect(notifyCounted).toHaveBeenCalledTimes(3);
    expect(args().data).not.toHaveProperty('topTitle');
  });

  it('produces nothing when the run created nothing', async () => {
    const result = await service.recordGenerated({
      circleId: 'circle-a',
      createdCount: 0,
      since: SINCE,
    });

    expect(result).toEqual({ recipients: 0, skipped: true });
    expect(scopeSummary).not.toHaveBeenCalled();
    expect(notifyCounted).not.toHaveBeenCalled();
  });

  it('produces nothing when the circle was deleted mid-run', async () => {
    scopeSummary.mockResolvedValue(null);

    const result = await service.recordGenerated({
      circleId: 'circle-a',
      createdCount: 4,
      since: SINCE,
    });

    expect(result).toEqual({ recipients: 0, skipped: true });
    expect(notifyCounted).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: recordGeneratedAsync never rejects', async () => {
    scopeSummary.mockRejectedValue(new Error('db down'));

    expect(() =>
      service.recordGeneratedAsync({ circleId: 'circle-a', createdCount: 2, since: SINCE }),
    ).not.toThrow();

    // Let the swallowed rejection settle; an unhandled rejection here would
    // fail the suite, which is exactly the regression this guards.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
