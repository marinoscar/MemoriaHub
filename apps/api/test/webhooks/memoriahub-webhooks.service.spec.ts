// =============================================================================
// MemoriaHubWebhooks and WebhookBatcher (RETRO-H4, #603)
// =============================================================================
//
// The volume guard (a 1 000-file import produces at most 10 events per media
// key), the time window, the "nobody subscribes" short cut, the workflow-run
// recipient resolution and the never-throws contract.
// =============================================================================

import { WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { webhookEventRegistry, WEBHOOKS_SYSTEM_ACCESS_REASON } from '@marinoscar/platform-api/webhooks';

import { MEMORIAHUB_WEBHOOK_EVENTS } from '../../src/platform/webhooks/memoriahub-webhook-events';
import {
  MEDIA_WEBHOOK_WINDOW_MS,
  MemoriaHubWebhooks,
} from '../../src/platform/webhooks/memoriahub-webhooks.service';
import { WebhookBatcher } from '../../src/platform/webhooks/webhook-batcher';

jest.mock('@marinoscar/platform-api/core', () => {
  const actual = jest.requireActual('@marinoscar/platform-api/core');
  // The bypass client is the app's own client in these tests.
  return { ...actual, forSystem: jest.fn((client: unknown) => client) };
});

const CIRCLE = '0f8b2c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f';
const USER = '3c3c3c3c-4d4d-4e5e-8f6f-7a7a7a7a7a7a';

function setup(eventKeys: string[][] = [['*']]) {
  const webhooks = {
    enqueueFanout: jest.fn(async () => 'event-id'),
    emit: jest.fn(async () => ({ matched: 1, queued: 1, eventId: 'e' })),
    emitForUser: jest.fn(async () => ({ matched: 1, queued: 1, eventId: 'e' })),
  };
  const prisma = {
    webhookEndpoint: { findMany: jest.fn(async () => eventKeys.map((keys) => ({ eventKeys: keys }))) },
    memory: { findMany: jest.fn(async () => [] as { id: string; type: string }[]) },
    workflowRun: { findUnique: jest.fn(async () => null as unknown) },
  };
  const service = new MemoriaHubWebhooks(webhooks as never, prisma as never);
  return { service, webhooks, prisma };
}

const item = (n: number) => ({
  id: `item-${n}`,
  circleId: CIRCLE,
  type: 'photo' as const,
  capturedAt: new Date('2025-12-24T18:30:00.000Z'),
  addedById: USER,
});

/** Validates each fanout's data against the registered schema (what the fanout job will do). */
function expectValidFanouts(calls: unknown[][]) {
  for (const [eventKey, data] of calls) {
    const def = webhookEventRegistry.get(eventKey as string);
    expect(def).toBeDefined();
    expect(def!.payloadSchema.safeParse(data).success).toBe(true);
  }
}

describe('WebhookBatcher', () => {
  afterEach(() => jest.useRealTimers());

  it('closes a batch at maxItems and after the window, never mixing buckets', async () => {
    jest.useFakeTimers();
    const flushed: { key: string; size: number }[] = [];
    const batcher = new WebhookBatcher<number>({
      maxItems: 3,
      windowMs: 1000,
      flush: async (batch) => {
        flushed.push({ key: batch.key, size: batch.items.length });
      },
    });
    batcher.add('a', [1, 2, 3, 4]);
    batcher.add('b', [1]);
    expect(flushed).toEqual([{ key: 'a', size: 3 }]);
    jest.advanceTimersByTime(1000);
    await batcher.drain();
    expect(flushed).toEqual([
      { key: 'a', size: 3 },
      { key: 'a', size: 1 },
      { key: 'b', size: 1 },
    ]);
    expect(batcher.openKeys()).toEqual([]);
  });

  it('swallows a failing flush', async () => {
    const batcher = new WebhookBatcher<number>({
      maxItems: 1,
      windowMs: 1000,
      flush: async () => {
        throw new Error('down');
      },
    });
    expect(() => batcher.add('a', [1])).not.toThrow();
    await expect(batcher.drain()).resolves.toBeUndefined();
  });
});

describe('MemoriaHubWebhooks: media', () => {
  it('a 1 000-file import produces 10 media.item.created and 10 media.upload.completed events', async () => {
    const { service, webhooks } = setup();
    for (let n = 0; n < 1000; n += 1) service.mediaCreated(item(n));
    await service.flushPending();

    const calls = webhooks.enqueueFanout.mock.calls as unknown[][];
    const byKey = (key: string) => calls.filter(([eventKey]) => eventKey === key);
    expect(byKey(MEMORIAHUB_WEBHOOK_EVENTS.itemCreated)).toHaveLength(10);
    expect(byKey(MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted)).toHaveLength(10);
    expectValidFanouts(calls);

    // The user event goes to the uploader; the system event to no user.
    for (const [eventKey, , context] of calls) {
      if (eventKey === MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted) expect(context).toMatchObject({ orgId: null, userId: USER });
      else expect(context).not.toHaveProperty('userId');
    }
    const created = byKey(MEMORIAHUB_WEBHOOK_EVENTS.itemCreated)[0][1] as { items: { mediaItemId: string }[] };
    expect(created.items).toHaveLength(100);
    expect(created.items[0]).toEqual({
      mediaItemId: 'item-0',
      mediaType: 'photo',
      capturedAt: '2025-12-24T18:30:00.000Z',
      addedById: USER,
    });
  });

  it('a slow trickle is flushed once the window closes', async () => {
    jest.useFakeTimers();
    try {
      const { service, webhooks } = setup();
      service.mediaTrashed(CIRCLE, ['a', 'b']);
      service.mediaTrashed(CIRCLE, ['c']);
      expect(webhooks.enqueueFanout).not.toHaveBeenCalled();
      jest.advanceTimersByTime(MEDIA_WEBHOOK_WINDOW_MS);
      await service.flushPending();
      expect(webhooks.enqueueFanout).toHaveBeenCalledTimes(1);
      expect(webhooks.enqueueFanout).toHaveBeenCalledWith(
        MEMORIAHUB_WEBHOOK_EVENTS.itemTrashed,
        { circleId: CIRCLE, count: 3, mediaItemIds: ['a', 'b', 'c'] },
        expect.objectContaining({ orgId: null }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('groups deleted rows by circle', async () => {
    const { service, webhooks } = setup();
    service.mediaDeleted([
      { id: 'a', circleId: 'circle-1' },
      { id: 'b', circleId: 'circle-2' },
      { id: 'c', circleId: 'circle-1' },
    ]);
    await service.flushPending();
    const calls = webhooks.enqueueFanout.mock.calls as unknown[][];
    expect(calls.map(([, data]) => data)).toEqual(
      expect.arrayContaining([
        { circleId: 'circle-1', count: 2, mediaItemIds: ['a', 'c'] },
        { circleId: 'circle-2', count: 1, mediaItemIds: ['b'] },
      ]),
    );
    expectValidFanouts(calls);
  });

  it('enqueues nothing while no enabled endpoint subscribes, and reads the endpoints through the bypass reason', async () => {
    const { service, webhooks, prisma } = setup([['workflows.*']]);
    service.mediaCreated(item(1));
    service.mediaTrashed(CIRCLE, ['a']);
    await service.flushPending();
    expect(webhooks.enqueueFanout).not.toHaveBeenCalled();
    expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledTimes(1); // cached across the batches
    const { forSystem } = jest.requireMock('@marinoscar/platform-api/core');
    expect(forSystem).toHaveBeenCalledWith(prisma, WEBHOOKS_SYSTEM_ACCESS_REASON);
  });

  it('never throws into the caller, even when the fan-out insert fails', async () => {
    const { service, webhooks } = setup();
    webhooks.enqueueFanout.mockRejectedValue(new Error('database down'));
    expect(() => service.mediaCreated(item(1))).not.toThrow();
    await expect(service.flushPending()).resolves.toBeUndefined();
  });
});

describe('MemoriaHubWebhooks: memories', () => {
  it('emits the pass\'s new memories in batches of 100 with their types', async () => {
    const { service, webhooks, prisma } = setup();
    const since = new Date('2026-01-01T00:00:00.000Z');
    prisma.memory.findMany.mockResolvedValue(
      Array.from({ length: 150 }, (_, n) => ({ id: `m-${n}`, type: n < 100 ? 'trip' : 'on_this_day' })),
    );
    await service.memoriesCreated(CIRCLE, since);
    expect(prisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { circleId: CIRCLE, deletedAt: null, generatedAt: { gte: since } } }),
    );
    expect(webhooks.emit).toHaveBeenCalledTimes(2);
    const [first, second] = webhooks.emit.mock.calls as unknown as [string, { count: number; types: string[] }, unknown][];
    expect(first[1]).toMatchObject({ count: 100, types: ['trip'] });
    expect(second[1]).toMatchObject({ count: 50, types: ['on_this_day'] });
    expectValidFanouts(webhooks.emit.mock.calls as unknown[][]);
  });
});

describe('MemoriaHubWebhooks: workflow runs', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 'run-1',
    workflowId: 'wf-1',
    circleId: CIRCLE,
    status: WorkflowRunStatus.completed,
    triggerType: WorkflowTrigger.manual,
    startedById: 'starter',
    matchedCount: 5,
    succeededCount: 4,
    failedCount: 1,
    workflow: { createdById: 'creator' },
    ...over,
  });

  it('a finished manual run goes to its starter', async () => {
    const { service, webhooks, prisma } = setup();
    prisma.workflowRun.findUnique.mockResolvedValue(run());
    await service.workflowRunFinished('run-1');
    expect(webhooks.emitForUser).toHaveBeenCalledWith('starter', MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted, {
      runId: 'run-1',
      workflowId: 'wf-1',
      circleId: CIRCLE,
      status: 'completed',
      trigger: 'manual',
      succeededCount: 4,
      failedCount: 1,
    });
    expectValidFanouts((webhooks.emitForUser.mock.calls as unknown[][]).map(([, key, data]) => [key, data]));
  });

  it('a scheduled run goes to the workflow creator', async () => {
    const { service, webhooks, prisma } = setup();
    prisma.workflowRun.findUnique.mockResolvedValue(run({ triggerType: WorkflowTrigger.scheduled }));
    await service.workflowRunFinished('run-1');
    expect(webhooks.emitForUser).toHaveBeenCalledWith('creator', expect.any(String), expect.any(Object));
  });

  it('a run that is not terminal (a rolled-back finalize) raises nothing', async () => {
    const { service, webhooks, prisma } = setup();
    prisma.workflowRun.findUnique.mockResolvedValue(run({ status: WorkflowRunStatus.running }));
    await service.workflowRunFinished('run-1');
    expect(webhooks.emitForUser).not.toHaveBeenCalled();
  });

  it('awaiting approval carries the matched count', async () => {
    const { service, webhooks, prisma } = setup();
    prisma.workflowRun.findUnique.mockResolvedValue(run({ status: WorkflowRunStatus.awaiting_approval }));
    await service.workflowRunAwaitingApproval('run-1');
    expect(webhooks.emitForUser).toHaveBeenCalledWith(
      'starter',
      MEMORIAHUB_WEBHOOK_EVENTS.workflowRunAwaitingApproval,
      { runId: 'run-1', workflowId: 'wf-1', circleId: CIRCLE, matchedCount: 5 },
    );
  });

  it('never throws when the run read fails', async () => {
    const { service, prisma } = setup();
    prisma.workflowRun.findUnique.mockRejectedValue(new Error('database down'));
    await expect(service.workflowRunFinished('run-1')).resolves.toBeUndefined();
  });
});
