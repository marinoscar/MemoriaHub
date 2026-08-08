// DB_GATED: This test requires a real PostgreSQL database with migrations
// applied (specifically 20260805000000_add_notifications). It will not run in
// environments without database connectivity. Unlike a plain env-var check
// (`.env.test` DECLARES `POSTGRES_HOST` even when no Postgres server is
// actually running, which would make an env-only gate a false positive), the
// skip decision here is backed by a SYNCHRONOUS TCP connectivity probe
// evaluated at module load, before `describe` is registered. That probe used
// to be inlined here; issue #288 moved it to
// test/helpers/db-probe.helper.ts (`describeMaybeDb`) so every DB-gated spec
// shares one implementation — see that helper's header for why it must be
// synchronous, and for the vacuous-pass defect it exists to prevent.
// When the probe fails, the whole suite is registered via a real
// `describe.skip`, so Jest reports these tests as SKIPPED, never PASSED. In
// CI (which has no live database — see docs/ci-known-failing-tests.md) this
// suite is a no-op: `describe.skip`, zero assertions executed, zero
// failures, and — critically — zero false passes.
//
// Purpose: exercise the REAL Postgres behavior of the partial unique index
// `notifications_review_queue_live_uniq_idx` added by migration
// 20260805000000_add_notifications, which the string/regex-based schema-drift
// guard at test/notifications/notification-schema-guard.spec.ts cannot do
// (that suite never touches a DB or a Prisma client — see its header
// comment). Specifically:
//
//   1. The dedup conflict fires: a second LIVE row for the same
//      (user_id, circle_id, type) among the four review_queue_* STATE types
//      is rejected with a genuine Postgres unique-violation (SQLSTATE 23505)
//      naming this index.
//   2. Dismissing the first row (dismissed_at set) releases the constraint —
//      a fresh live row for the same triple can now be inserted.
//   3. The four EVENT types (upload_completed, enrichment_failed, ...) never
//      match the index's predicate and are therefore never deduplicated —
//      multiple live rows of the same event type for the same user (and, for
//      circle_id IS NULL global rows, no circle) all succeed.
//   4. Distinguishing any one of type / circle_id / user_id is enough to
//      avoid a collision — the index is genuinely scoped to the full
//      (user_id, circle_id, type) triple, not some subset of it.
//   5. The intended producer write shape — an INSERT ... ON CONFLICT
//      (user_id, circle_id, type) WHERE <predicate> DO UPDATE upsert that
//      refreshes `data` in place instead of appending a second row — is the
//      real, correct SQL against a partial unique index (Postgres requires
//      the ON CONFLICT clause's WHERE predicate to exactly restate the
//      index's predicate for a partial index to be usable as the arbiter).
//
// NOTE ON THE ERROR-SHAPE ASSERTIONS (honesty box): this repo runs Prisma 7
// (`@prisma/client` + `@prisma/adapter-pg` driver adapter, see package.json).
// Reading that adapter's installed runtime
// (node_modules/@prisma/adapter-pg/dist/index.js) shows a raw query
// ($queryRaw/$executeRaw) failure is wrapped as a PrismaClientKnownRequestError
// with code 'P2010' and a message of the literal shape
// "Raw query failed. Code: `<sqlstate>`. Message: `<original postgres error>`"
// — i.e. both the real SQLSTATE (23505 for a unique violation) AND the
// original Postgres message (which names the failing index, e.g.
// `duplicate key value violates unique constraint
// "notifications_review_queue_live_uniq_idx"`) are preserved verbatim. This
// is DIFFERENT from Prisma's friendlier ORM-level P2002 translation for a
// plain `.create()` call, which reports only field names, never the index
// name (see test/review-runs/review-runs.integration.spec.ts's header
// comment for that same empirically-documented distinction) — which is why
// every insert in this suite goes through raw SQL ($executeRaw) rather than
// `.create()`. This P2010 shape was derived by reading the installed
// dependency source, NOT by running this suite against a live database (none
// is available in this sandbox) — if it ever fails against a real DB, the
// fix is almost certainly a message-shape assertion drift, not a real dedup
// regression; check the actual error object shape and adjust
// `expectUniqueViolation` below rather than deleting the assertion.

import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';

// ---------------------------------------------------------------------------
// Build a Postgres connection string from environment variables, mirroring
// the logic in PrismaService (and test/circles/migration-backfill.integration.spec.ts)
// so we use the same DB as the rest of the tests.
// ---------------------------------------------------------------------------

function buildConnectionString(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const user = process.env.POSTGRES_USER ?? 'postgres';
  const password = process.env.POSTGRES_PASSWORD ?? 'postgres';
  const dbName = process.env.POSTGRES_DB ?? 'appdb';
  const encoded = encodeURIComponent(password);
  return `postgresql://${user}:${encoded}@${host}:${port}/${dbName}`;
}

// ---------------------------------------------------------------------------
// Test data IDs — unique per run so parallel runs do not collide.
// ---------------------------------------------------------------------------

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8);

function padId(prefix: string): string {
  return `${prefix}-${RUN_ID}`.padEnd(36, '0').slice(0, 36);
}

const USER_1_ID = padId('usr1');
const USER_2_ID = padId('usr2');
const CIRCLE_1_ID = padId('crl1');
const CIRCLE_2_ID = padId('crl2');

const INDEX_NAME = 'notifications_review_queue_live_uniq_idx';

// The four review_queue_* STATE types the partial unique index covers.
type ReviewQueueType =
  | 'review_queue_bursts'
  | 'review_queue_duplicates'
  | 'review_queue_location_suggestions'
  | 'review_queue_enhancements';

describeMaybeDb('Notification review-queue dedup (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // PrismaClient in this project requires the PrismaPg driver adapter
    const adapter = new PrismaPg(buildConnectionString());
    prisma = new PrismaClient({ adapter } as any);
    await prisma.$connect();
    await seedFixtures(prisma);
  }, 30000);

  afterAll(async () => {
    await cleanupFixtures(prisma);
    await prisma.$disconnect();
  }, 30000);

  // -------------------------------------------------------------------------
  // Raw-SQL helpers. All notification inserts in this suite go through
  // $executeRaw (never `.notification.create()`) so that a unique-violation
  // failure surfaces Prisma's raw-query P2010 error shape, which preserves
  // the original Postgres SQLSTATE and message text (including the index
  // name) — see the file header's "honesty box" for why the friendlier ORM
  // P2002 path would NOT let us assert the index name.
  // -------------------------------------------------------------------------

  async function insertNotification(params: {
    id: string;
    userId: string;
    circleId: string | null;
    type: string;
    title: string;
  }): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO notifications (id, user_id, circle_id, type, title)
      VALUES (
        ${params.id}::uuid,
        ${params.userId}::uuid,
        ${params.circleId}::uuid,
        ${params.type}::"NotificationType",
        ${params.title}
      )
    `;
  }

  /**
   * The intended producer write shape (requirement 5): an upsert against the
   * partial unique index that refreshes `data` in place. Postgres requires
   * an ON CONFLICT ... WHERE clause targeting a partial index to restate the
   * index's predicate exactly — this text must stay byte-for-byte in sync
   * with the migration's index predicate (see migration.sql and the
   * schema-drift guard spec, which independently pins that same text).
   */
  async function upsertReviewQueueNotification(params: {
    id: string;
    userId: string;
    circleId: string;
    type: ReviewQueueType;
    title: string;
    count: number;
  }): Promise<void> {
    const dataJson = JSON.stringify({ count: params.count });
    await prisma.$executeRaw`
      INSERT INTO notifications (id, user_id, circle_id, type, title, data)
      VALUES (
        ${params.id}::uuid,
        ${params.userId}::uuid,
        ${params.circleId}::uuid,
        ${params.type}::"NotificationType",
        ${params.title},
        ${dataJson}::jsonb
      )
      ON CONFLICT (user_id, circle_id, type)
      WHERE "dismissed_at" IS NULL
        AND "circle_id" IS NOT NULL
        AND "type" IN (
          'review_queue_bursts',
          'review_queue_duplicates',
          'review_queue_location_suggestions',
          'review_queue_enhancements'
        )
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `;
  }

  /**
   * Awaits `promise`, asserts it rejected, and asserts the rejection is a
   * genuine Postgres unique-violation (SQLSTATE 23505) naming `indexName` —
   * not merely "something threw". See the file header's honesty box for the
   * expected error shape and why it is unverified against a live DB in this
   * environment.
   */
  async function expectUniqueViolation(promise: Promise<unknown>, indexName: string): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Prisma.PrismaClientKnownRequestError;
    // Prisma's raw-query error code for a failed $executeRaw/$queryRaw.
    expect(err.code).toBe('P2010');
    // The real Postgres SQLSTATE for a unique_violation.
    expect(err.message).toContain('23505');
    // The actual failing index's name, proving THIS constraint fired and not
    // some other one.
    expect(err.message).toContain(indexName);
  }

  async function countLive(userId: string, circleId: string | null, type: string): Promise<number> {
    return prisma.notification.count({
      where: { userId, circleId, type: type as any, dismissedAt: null },
    });
  }

  // =========================================================================
  // 1 & 2. The dedup conflict fires, and dismissing releases it.
  // =========================================================================

  describe('dedup conflict and release', () => {
    const userId = USER_1_ID;
    const circleId = CIRCLE_1_ID;
    const type: ReviewQueueType = 'review_queue_duplicates';
    let firstRowId: string;

    it(
      'a second live row for the same (user, circle, type) is rejected as a 23505 unique violation naming the index',
      async () => {
        firstRowId = randomUUID();
        await insertNotification({
          id: firstRowId,
          userId,
          circleId,
          type,
          title: `Dedup test — first live row (${RUN_ID})`,
        });

        await expectUniqueViolation(
          insertNotification({
            id: randomUUID(),
            userId,
            circleId,
            type,
            title: `Dedup test — should be rejected (${RUN_ID})`,
          }),
          INDEX_NAME,
        );

        // Exactly one live row exists — the rejected insert did not partially apply.
        expect(await countLive(userId, circleId, type)).toBe(1);
      },
    );

    it(
      'dismissing the first row allows a fresh live row for the same (user, circle, type) to insert successfully',
      async () => {
        await prisma.notification.update({
          where: { id: firstRowId },
          data: { dismissedAt: new Date() },
        });

        // No live row remains for this triple now.
        expect(await countLive(userId, circleId, type)).toBe(0);

        const secondRowId = randomUUID();
        await insertNotification({
          id: secondRowId,
          userId,
          circleId,
          type,
          title: `Dedup test — re-notify after dismiss (${RUN_ID})`,
        });

        expect(await countLive(userId, circleId, type)).toBe(1);
        const row = await prisma.notification.findUnique({ where: { id: secondRowId } });
        expect(row).not.toBeNull();
        expect(row!.dismissedAt).toBeNull();
      },
    );
  });

  // =========================================================================
  // 3. Event types are exempt — never deduplicated.
  // =========================================================================

  describe('event types are exempt from dedup', () => {
    it(
      'two live upload_completed rows for the same (user, circle) both insert successfully',
      async () => {
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_1_ID,
          type: 'upload_completed',
          title: `Event exemption test — upload 1 (${RUN_ID})`,
        });
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_1_ID,
          type: 'upload_completed',
          title: `Event exemption test — upload 2 (${RUN_ID})`,
        });

        const count = await prisma.notification.count({
          where: { userId: USER_1_ID, circleId: CIRCLE_1_ID, type: 'upload_completed' },
        });
        expect(count).toBe(2);
      },
    );

    it(
      'two live global (circle_id = NULL) enrichment_failed rows for the same user both insert successfully',
      async () => {
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: null,
          type: 'enrichment_failed',
          title: `Event exemption test — global failure 1 (${RUN_ID})`,
        });
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: null,
          type: 'enrichment_failed',
          title: `Event exemption test — global failure 2 (${RUN_ID})`,
        });

        const count = await prisma.notification.count({
          where: { userId: USER_1_ID, circleId: null, type: 'enrichment_failed' },
        });
        expect(count).toBe(2);
      },
    );
  });

  // =========================================================================
  // 4. Differing type / circle / user avoids collision.
  // =========================================================================

  describe('differing type, circle, or user avoids collision', () => {
    it(
      'live review_queue_bursts and review_queue_location_suggestions for the same (user, circle) both succeed (different type)',
      async () => {
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_1_ID,
          type: 'review_queue_bursts',
          title: `Different-type test — bursts (${RUN_ID})`,
        });
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_1_ID,
          type: 'review_queue_location_suggestions',
          title: `Different-type test — location suggestions (${RUN_ID})`,
        });

        expect(await countLive(USER_1_ID, CIRCLE_1_ID, 'review_queue_bursts')).toBe(1);
        expect(await countLive(USER_1_ID, CIRCLE_1_ID, 'review_queue_location_suggestions')).toBe(1);
      },
    );

    it(
      'the same type across two different circles for the same user both succeed (different circle)',
      async () => {
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_1_ID,
          type: 'review_queue_enhancements',
          title: `Different-circle test — circle 1 (${RUN_ID})`,
        });
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_2_ID,
          type: 'review_queue_enhancements',
          title: `Different-circle test — circle 2 (${RUN_ID})`,
        });

        expect(await countLive(USER_1_ID, CIRCLE_1_ID, 'review_queue_enhancements')).toBe(1);
        expect(await countLive(USER_1_ID, CIRCLE_2_ID, 'review_queue_enhancements')).toBe(1);
      },
    );

    it(
      'the same type across two different users for the same circle both succeed (different user)',
      async () => {
        await insertNotification({
          id: randomUUID(),
          userId: USER_1_ID,
          circleId: CIRCLE_2_ID,
          type: 'review_queue_duplicates',
          title: `Different-user test — user 1 (${RUN_ID})`,
        });
        await insertNotification({
          id: randomUUID(),
          userId: USER_2_ID,
          circleId: CIRCLE_2_ID,
          type: 'review_queue_duplicates',
          title: `Different-user test — user 2 (${RUN_ID})`,
        });

        expect(await countLive(USER_1_ID, CIRCLE_2_ID, 'review_queue_duplicates')).toBe(1);
        expect(await countLive(USER_2_ID, CIRCLE_2_ID, 'review_queue_duplicates')).toBe(1);
      },
    );
  });

  // =========================================================================
  // 5. The intended producer write shape: ON CONFLICT upsert.
  // =========================================================================

  describe('upsert against the partial index refreshes data.count in place', () => {
    it(
      'an ON CONFLICT (user_id, circle_id, type) WHERE <predicate> DO UPDATE upsert results in exactly one row with the refreshed count',
      async () => {
        const userId = USER_2_ID;
        const circleId = CIRCLE_1_ID;
        const type: ReviewQueueType = 'review_queue_bursts';

        await upsertReviewQueueNotification({
          id: randomUUID(),
          userId,
          circleId,
          type,
          title: `Upsert test (${RUN_ID})`,
          count: 5,
        });

        const afterFirst = await prisma.notification.findMany({
          where: { userId, circleId, type, dismissedAt: null },
        });
        expect(afterFirst).toHaveLength(1);
        expect((afterFirst[0].data as any)?.count).toBe(5);
        const firstRowId = afterFirst[0].id;

        // A second upsert against the SAME triple must refresh `data` on the
        // existing row rather than inserting a second one.
        await upsertReviewQueueNotification({
          id: randomUUID(), // deliberately a different id — proves the arbiter wins, not our chosen id
          userId,
          circleId,
          type,
          title: `Upsert test — refreshed (${RUN_ID})`,
          count: 42,
        });

        const afterSecond = await prisma.notification.findMany({
          where: { userId, circleId, type, dismissedAt: null },
        });
        expect(afterSecond).toHaveLength(1);
        expect(afterSecond[0].id).toBe(firstRowId); // same row, not a new one
        expect((afterSecond[0].data as any)?.count).toBe(42);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.user.createMany({
    data: [
      {
        id: USER_1_ID,
        email: `notification-dedup-test-u1-${RUN_ID}@example.com`,
        providerDisplayName: 'Notification Dedup Test User 1',
        isActive: true,
      },
      {
        id: USER_2_ID,
        email: `notification-dedup-test-u2-${RUN_ID}@example.com`,
        providerDisplayName: 'Notification Dedup Test User 2',
        isActive: true,
      },
    ],
    skipDuplicates: true,
  });

  await prisma.circle.createMany({
    data: [
      {
        id: CIRCLE_1_ID,
        name: `Notification Dedup Test Circle 1 (${RUN_ID})`,
        ownerId: USER_1_ID,
        isPersonal: false,
      },
      {
        id: CIRCLE_2_ID,
        name: `Notification Dedup Test Circle 2 (${RUN_ID})`,
        ownerId: USER_1_ID,
        isPersonal: false,
      },
    ],
    skipDuplicates: true,
  });
}

async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  // Reverse-order teardown to respect FK constraints. Deleting notifications
  // explicitly first (rather than relying on the ON DELETE CASCADE from
  // circles/users) keeps this scoped and makes the cleanup order obvious.
  await prisma.notification.deleteMany({
    where: { userId: { in: [USER_1_ID, USER_2_ID] } },
  });
  await prisma.circle.deleteMany({ where: { id: { in: [CIRCLE_1_ID, CIRCLE_2_ID] } } });
  await prisma.user.deleteMany({ where: { id: { in: [USER_1_ID, USER_2_ID] } } });
}
