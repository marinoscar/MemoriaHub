/**
 * The review-queue reconcile over the real notification inbox (RETRO-J10 #624, gap closed by the retro-gaps audit).
 *
 * `review-queue-reconcile.service.spec.ts` proves the producer asks for the right `notifyState` writes against a
 * double. What a double cannot prove is the guarantee the whole design rests on: that the four `review.*` STATE
 * events leave exactly ONE live inbox row per (user, scope, event), however many times the sweep runs, refreshed
 * in place, with the `countAtRead` re-unread rule honoured by the platform inbox. This spec boots the real app on
 * real PostgreSQL, takes the real `MEMORIAHUB_NOTIFY` adapter (platform `NotificationsService` + the partial unique
 * index `notifications_live_dedup_uniq_idx`) and the real `NotificationStoreService` (the user's "mark read"), and
 * runs the real `ReviewQueueReconcileService` over them. Only the library roster and the counts are stubbed: the
 * sweep's own inputs.
 *
 * DB_GATED: reported as skipped (never passed) when no database is reachable.
 */
import { randomUUID } from 'node:crypto';

import { ReviewQueueCounterRegistry, ReviewQueueReconcileService } from '@marinoscar/memoriahub-api/media';
import { MEMORIAHUB_NOTIFY } from '@marinoscar/memoriahub-api/ports';

import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const EVENTS = ['review.bursts', 'review.duplicates', 'review.location_suggestions', 'review.enhancements'] as const;
const ALL_ON = { burstDetection: true, duplicateDetection: true, locationInference: true, pictureEnhancement: true };

describeMaybeDb('Review-queue reconcile over the real inbox (DB_GATED: real PostgreSQL)', () => {
  let context: TestContext;
  let service: ReviewQueueReconcileService;
  /** The platform inbox store (not exported from the package index): found among the booted app's providers. */
  let store: { markRead(userId: string, id: string): Promise<number> };

  const scopeId = randomUUID();
  const otherScopeId = randomUUID();
  const userIds: string[] = [];
  let members: string[] = [];
  let features: Record<string, boolean> = ALL_ON;
  let pending: Record<string, number> = {};
  let scopes: Array<{ id: string; name: string }> = [];

  const counts = (over: Record<string, number> = {}) => ({
    pendingBurstGroups: 0,
    pendingDuplicateGroups: 0,
    pendingLocationSuggestions: 0,
    pendingEnhancements: 0,
    ...over,
  });

  const rows = (where: Record<string, unknown> = {}) =>
    context.prisma.notification.findMany({
      where: { userId: { in: userIds }, eventKey: { in: [...EVENTS] }, ...where },
      orderBy: [{ userId: 'asc' }, { eventKey: 'asc' }],
    });

  /** The inbox writes are detached from the sweep, so wait until the inbox reaches the expectation. */
  async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> {
    let last: T | undefined;
    for (let i = 0; i < 100; i += 1) {
      last = await read();
      if (ok(last)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for: ${what}. Last: ${JSON.stringify(last)}`);
  }

  const sweep = () => service.reconcileAll();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: false });
    for (const mod of (context.module as unknown as { container: { getModules(): Map<unknown, { providers: Map<unknown, { metatype?: { name?: string }; instance?: unknown }> }> } }).container.getModules().values()) {
      for (const wrapper of mod.providers.values()) {
        if (wrapper.metatype?.name === 'NotificationStoreService' && wrapper.instance) store = wrapper.instance as typeof store;
      }
    }
    if (!store) throw new Error('NotificationStoreService is not provided by the booted app');

    for (const label of ['a', 'b', 'viewer']) {
      const user = await context.prisma.user.create({ data: { email: `review-reconcile-${label}-${randomUUID()}@example.test` } });
      userIds.push(user.id);
    }
    members = [userIds[0]!, userIds[1]!]; // the third user is a viewer: never in the eligible roster

    const registry = context.module.get(ReviewQueueCounterRegistry, { strict: false });
    service = new ReviewQueueReconcileService(
      context.module.get(MEMORIAHUB_NOTIFY, { strict: false }),
      {
        allScopes: async () => scopes.map((s) => ({ ...s, kind: 'group' as const, ownerId: null, createdById: null })),
        membersOf: async (id: string) => (id === scopeId ? members.map((userId) => ({ userId })) : []),
      } as never,
      { readSystem: async () => ({ value: features }) } as never,
      { computeReviewCounts: async (id: string) => counts(id === scopeId ? pending : {}) } as never,
      registry,
    );
  }, 90000);

  afterAll(async () => {
    if (context?.prisma && userIds.length > 0) {
      await context.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await context.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (context) await closeTestApp(context);
  });

  beforeEach(async () => {
    await context.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    features = ALL_ON;
    members = [userIds[0]!, userIds[1]!];
    scopes = [{ id: scopeId, name: 'Family' }];
    pending = { pendingBurstGroups: 5, pendingDuplicateGroups: 929, pendingLocationSuggestions: 2, pendingEnhancements: 1 };
  });

  it('leaves exactly one live row per (user, library, event), however many sweeps run', async () => {
    await sweep();
    const first = await eventually(() => rows(), (r) => r.length === 8, 'eight rows (2 eligible users x 4 queues)');

    await sweep();
    await sweep();
    await new Promise((r) => setTimeout(r, 300));
    const after = await rows();

    expect(after).toHaveLength(8);
    expect(after.every((r) => r.dismissedAt === null && r.scopeId === scopeId)).toBe(true);
    // One row per key: the (user, event) pairs are all distinct, and the same row ids survived the re-sweeps.
    expect(new Set(after.map((r) => `${r.userId}|${r.eventKey}`)).size).toBe(8);
    expect(after.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    // The viewer is not in the roster, so the viewer has no row at all.
    expect(after.some((r) => r.userId === userIds[2])).toBe(false);
  });

  it('collapses 929 pending groups into one row whose count is 929, never one row per group', async () => {
    await sweep();
    const dup = await eventually(
      () => rows({ eventKey: 'review.duplicates', userId: userIds[0] }),
      (r) => r.length === 1,
      'the duplicates row',
    );
    expect(dup).toHaveLength(1);
    expect((dup[0]!.data as { count: number }).count).toBe(929);
  });

  it('refreshes the live row in place when the count changes (same id, new count)', async () => {
    await sweep();
    const before = await eventually(() => rows({ eventKey: 'review.bursts', userId: userIds[0] }), (r) => r.length === 1, 'the burst row');

    pending = { ...pending, pendingBurstGroups: 8 };
    await sweep();
    const after = await eventually(
      () => rows({ eventKey: 'review.bursts', userId: userIds[0] }),
      (r) => r.length === 1 && (r[0]!.data as { count: number }).count === 8,
      'the burst row refreshed to 8',
    );

    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.dismissedAt).toBeNull();
    expect(await context.prisma.notification.count({ where: { userId: userIds[0], eventKey: 'review.bursts' } })).toBe(1);
  });

  it('re-marks a read row unread only when the count grows past the countAtRead the user saw', async () => {
    const key = { eventKey: 'review.bursts', userId: userIds[0] };
    await sweep();
    const created = await eventually(() => rows(key), (r) => r.length === 1, 'the burst row');
    expect(created[0]!.readAt).toBeNull();

    // The user reads it at count 5: readAt set, countAtRead snapshotted.
    await store.markRead(userIds[0]!, created[0]!.id);
    const read = (await rows(key))[0]!;
    expect(read.readAt).not.toBeNull();
    expect((read.data as { countAtRead?: number }).countAtRead).toBe(5);

    // An equal count and a smaller count never re-nag.
    await sweep();
    pending = { ...pending, pendingBurstGroups: 3 };
    await sweep();
    await eventually(() => rows(key), (r) => (r[0]!.data as { count: number }).count === 3, 'refreshed down to 3');
    expect((await rows(key))[0]!.readAt).not.toBeNull();
    // The snapshot is carried forward across refreshes, not synthesized away.
    expect(((await rows(key))[0]!.data as { countAtRead?: number }).countAtRead).toBe(5);

    // Growth past what the user saw (5 -> 6) makes it unread again, on the same row.
    pending = { ...pending, pendingBurstGroups: 6 };
    await sweep();
    const regrown = await eventually(() => rows(key), (r) => r.length === 1 && r[0]!.readAt === null, 'unread again at 6');
    expect(regrown[0]!.id).toBe(created[0]!.id);
    expect((regrown[0]!.data as { count: number }).count).toBe(6);
  });

  it('dismisses the live row when the queue drains to zero and starts a fresh live row when it refills', async () => {
    const key = { eventKey: 'review.duplicates', userId: userIds[0] };
    await sweep();
    const first = await eventually(() => rows(key), (r) => r.length === 1, 'the duplicates row');

    pending = { ...pending, pendingDuplicateGroups: 0 };
    await sweep();
    await eventually(() => rows(key), (r) => r.length === 1 && r[0]!.dismissedAt !== null, 'the row dismissed');
    expect(await rows({ ...key, dismissedAt: null })).toHaveLength(0);

    pending = { ...pending, pendingDuplicateGroups: 4 };
    await sweep();
    await eventually(() => rows({ ...key, dismissedAt: null }), (r) => r.length === 1, 'a new live row');

    const all = await rows(key);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.dismissedAt === null)).toHaveLength(1);
    expect(all.find((r) => r.dismissedAt === null)!.id).not.toBe(first[0]!.id);
  });

  it('drains the live row of a member who can no longer act on the queue (demoted or removed)', async () => {
    await sweep();
    await eventually(() => rows({ userId: userIds[1] }), (r) => r.length === 4, 'four rows for the second member');

    members = [userIds[0]!];
    await sweep();
    await eventually(() => rows({ userId: userIds[1], dismissedAt: null }), (r) => r.length === 0, 'the removed member drained');
    expect(await rows({ userId: userIds[0], dismissedAt: null })).toHaveLength(4);
  });

  it('keeps libraries apart: one live row per library for the same user and event', async () => {
    scopes = [
      { id: scopeId, name: 'Family' },
      { id: otherScopeId, name: 'Work' },
    ];
    await sweep();
    await eventually(() => rows({ userId: userIds[0] }), (r) => r.length === 4, 'rows for the first library only');
    // The second library has no eligible member and no pending count: nothing is raised for it.
    expect(await rows({ scopeId: otherScopeId })).toHaveLength(0);
    expect(await rows({ userId: userIds[0], scopeId })).toHaveLength(4);
  });

  it('drains the live rows of a queue an administrator switches off and raises nothing for it', async () => {
    await sweep();
    await eventually(() => rows({ eventKey: 'review.enhancements' }), (r) => r.length === 2, 'the enhancement rows');

    features = { ...ALL_ON, pictureEnhancement: false };
    await sweep();
    await eventually(() => rows({ eventKey: 'review.enhancements', dismissedAt: null }), (r) => r.length === 0, 'enhancement rows dismissed');
    // The other three queues are untouched.
    expect(await rows({ dismissedAt: null })).toHaveLength(6);
  });
});
