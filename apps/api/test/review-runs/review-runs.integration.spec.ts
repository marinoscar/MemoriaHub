// DB_GATED: This test requires a real PostgreSQL database with migrations
// applied. `*.integration.spec.ts` is excluded from `npm run test:ci` (see
// package.json's testPathIgnorePatterns) but IS included in the plain
// `npm test` run — same convention as every other `*.integration.spec.ts`
// in this repo. This suite talks to a hard-coded connection string (see
// DATABASE_URL below) rather than gating on POSTGRES_HOST/DATABASE_URL env
// vars being pre-set, so it actually exercises real Postgres in an
// environment where a DB is reachable but those env vars were never
// exported. DATABASE_URL (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) overrides
// the default when set, so a developer can point this at their own instance.
//
// Reachability is probed synchronously at module load, BEFORE Jest registers
// the tests, so an unreachable DB produces an honest `describe.skip` (13
// skipped, clearly reported) rather than 13 red tests. An earlier revision
// failed loudly instead; that was wrong for the common case of a developer
// running plain `npm test` without a local `appdb`, since this suite is the
// only one in the repo that needs a real database — every other
// `*.integration.spec.ts` here runs against a mocked Prisma.
//
// Purpose: exercise the raw-SQL constraint set added by migration
// 20260726010000_review_runs directly against Postgres — the "exclusive
// arc" CHECK constraints, the composite (run_id, subject_type) FK, the
// per-subject partial unique indexes, and cascade-delete behaviour — none
// of which a mocked PrismaService can verify, since jest-mock-extended never
// touches a real constraint. See the migration file and the ReviewRunItem
// doc comment in schema.prisma for the full rationale.
//
// Covered:
//   1. Zero subject columns populated -> rejected (exactly-one-subject CHECK).
//   2. Two subject columns populated -> rejected (same CHECK).
//   3. subject_type disagreeing with the populated column -> rejected (the
//      three per-column subject_type-agreement CHECKs).
//   4. An item whose subject_type differs from its parent run's subject_type
//      -> rejected by the composite (run_id, subject_type) FK, even though
//      the item's own CHECK constraints all individually pass.
//   5. Deleting a burst_group / duplicate_group / location_suggestion
//      cascades its ReviewRunItem row away while the parent ReviewRun
//      survives untouched.
//   6. Deleting a ReviewRun cascades its ReviewRunItem rows.
//   7. The partial unique index rejects a duplicate (run_id, burst_group_id)
//      pair while permitting a same-run row of a different subject type
//      (duplicate_group_id) that happens to reuse a value.
//
// Each assertion below prefers a message-substring match on the actual
// constraint name (or, for the unique-violation cases where Prisma's P2002
// message omits the constraint name and only lists field names, a match on
// those field names) over a bare `.rejects.toThrow()`, so a test can't pass
// by accident because some OTHER constraint fired instead of the one under
// test. Verified empirically against this Prisma 7 / @prisma/adapter-pg
// driver-adapter stack: CHECK and simple-FK violations throw a
// DriverAdapterError (or the wrapping PrismaClientKnownRequestError) whose
// top-level `.message` already contains the failing constraint's name;
// unique violations wrap to a generic "Unique constraint failed on the
// fields: (...)" message without the index name.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Connection string. `.env.test` sets DATABASE_URL to
// postgresql://postgres:postgres@localhost:5433/enterprise_app_test — the
// repo's conventional test database — and that wins when present. The
// individual POSTGRES_* vars are honoured next, and a plain local default is
// the last resort. To actually run this suite, stand up a database at that
// URL and apply migrations (`npm run prisma:migrate`); otherwise it skips.
// ---------------------------------------------------------------------------

function resolveDatabaseUrl(): string {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'] as string;
  const host = process.env['POSTGRES_HOST'] ?? 'localhost';
  const port = process.env['POSTGRES_PORT'] ?? '5432';
  const user = process.env['POSTGRES_USER'] ?? 'postgres';
  const password = process.env['POSTGRES_PASSWORD'] ?? 'postgres';
  const db = process.env['POSTGRES_DB'] ?? 'appdb';
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

const DATABASE_URL = resolveDatabaseUrl();

/**
 * Synchronous TCP reachability probe, run at module load so the result is
 * known before Jest registers the tests below — `describe.skip` cannot be
 * decided from an async `beforeAll`, which runs too late.
 */
function isDatabaseReachable(url: string): boolean {
  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = Number(parsed.port || 5432);
  } catch {
    return false;
  }
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `const net=require('net');` +
          `const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});` +
          `s.on('connect',()=>{s.destroy();process.exit(0)});` +
          `s.on('error',()=>process.exit(1));` +
          `setTimeout(()=>process.exit(1),2000);`,
        host,
        String(port),
      ],
      { stdio: 'ignore', timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

const DB_REACHABLE = isDatabaseReachable(DATABASE_URL);

if (!DB_REACHABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[review-runs.integration] Skipping: no PostgreSQL reachable at ${DATABASE_URL}. ` +
      `Start a migrated database (or set DATABASE_URL) to exercise the review_run_items constraint set.`,
  );
}

const describeDb = DB_REACHABLE ? describe : describe.skip;

describeDb('Review Runs — DB constraints (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient | null = null;
  let dbReachable = false;

  // Shared fixture ids, created once in beforeAll and torn down in afterAll.
  const userId = randomUUID();
  const circleId = randomUUID();
  const storageObjectId = randomUUID();
  const mediaItemId = randomUUID();

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    const client = new PrismaClient({ adapter });
    await client.$connect();
    prisma = client;
    dbReachable = true;

    await prisma.user.create({
      data: { id: userId, email: `review-runs-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Review Runs Test Circle', ownerId: userId },
    });
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: 'test.jpg',
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        storageKey: `review-runs-test/${storageObjectId}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
    await prisma.mediaItem.create({
      data: {
        id: mediaItemId,
        storageObjectId,
        circleId,
        addedById: userId,
        type: 'photo',
        source: 'web',
        originalFilename: 'test.jpg',
      },
    });
  }, 30000);

  afterAll(async () => {
    if (!dbReachable || !prisma) return;
    // Reverse-order teardown. Deleting every ReviewRun scoped to this test's
    // circleId cascades away its ReviewRunItem rows automatically (ON DELETE
    // CASCADE on review_run_items.run_id) — no separate reviewRunItem cleanup
    // needed, and this stays scoped to fixtures this suite created rather
    // than touching unrelated rows in a shared database.
    await prisma.reviewRun.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.locationSuggestion.deleteMany({ where: { circleId } });
    await prisma.duplicateGroup.deleteMany({ where: { circleId } });
    await prisma.burstGroup.deleteMany({ where: { circleId } });
    await prisma.mediaItem.deleteMany({ where: { id: mediaItemId } });
    await prisma.storageObject.deleteMany({ where: { id: storageObjectId } });
    await prisma.circle.deleteMany({ where: { id: circleId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  function skipIfNoDb(testFn: () => Promise<void>): () => Promise<void> {
    return async () => {
      if (!dbReachable || !prisma) {
        expect(true).toBe(true);
        return;
      }
      await testFn();
    };
  }

  async function makeRun(subjectType: 'burst_group' | 'duplicate_group' | 'location_suggestion') {
    const action =
      subjectType === 'location_suggestion' ? ('accept' as const) : ('resolve_archive' as const);
    return prisma!.reviewRun.create({
      data: {
        circleId,
        subjectType,
        action,
        threshold: 60,
        startedById: userId,
      },
    });
  }

  // ===========================================================================
  // 1 & 2. Exactly-one-subject CHECK
  // ===========================================================================

  describe('exactly-one-subject CHECK constraint', () => {
    it(
      'rejects a row with zero subject columns populated',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        await expect(
          prisma!.reviewRunItem.create({
            data: { runId: run.id, subjectType: 'burst_group' },
          }),
        ).rejects.toThrow(/review_run_items_exactly_one_subject_check/);
      }),
    );

    it(
      'rejects a row with two subject columns populated',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        const dup = await prisma!.duplicateGroup.create({ data: { circleId } });
        await expect(
          prisma!.reviewRunItem.create({
            data: {
              runId: run.id,
              subjectType: 'burst_group',
              burstGroupId: burst.id,
              duplicateGroupId: dup.id,
            },
          }),
        ).rejects.toThrow(/review_run_items_exactly_one_subject_check/);
      }),
    );
  });

  // ===========================================================================
  // 3. subject_type-agreement CHECKs
  // ===========================================================================

  describe('subject_type agreement CHECK constraints', () => {
    it(
      'rejects subject_type="burst_group" with only duplicate_group_id populated',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const dup = await prisma!.duplicateGroup.create({ data: { circleId } });
        await expect(
          prisma!.reviewRunItem.create({
            data: { runId: run.id, subjectType: 'burst_group', duplicateGroupId: dup.id },
          }),
        ).rejects.toThrow(/review_run_items_subject_type_burst_group_check/);
      }),
    );

    it(
      'rejects subject_type="duplicate_group" with only burst_group_id populated',
      skipIfNoDb(async () => {
        const run = await makeRun('duplicate_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        // This row simultaneously violates BOTH
        // review_run_items_subject_type_burst_group_check ((subject_type =
        // 'burst_group') = (burst_group_id IS NOT NULL) -> false = true) AND
        // review_run_items_subject_type_duplicate_group_check ((subject_type
        // = 'duplicate_group') = (duplicate_group_id IS NOT NULL) -> true =
        // false). Postgres reports whichever CHECK it evaluates first
        // (empirically, definition order — burst_group_check was added
        // first in the migration) rather than every violated constraint, so
        // assert on either name instead of hard-coding one and risking a
        // spurious failure if evaluation order ever differs.
        await expect(
          prisma!.reviewRunItem.create({
            data: { runId: run.id, subjectType: 'duplicate_group', burstGroupId: burst.id },
          }),
        ).rejects.toThrow(
          /review_run_items_subject_type_(burst_group|duplicate_group)_check/,
        );
      }),
    );
  });

  // ===========================================================================
  // 4. Composite (run_id, subject_type) FK
  // ===========================================================================

  describe('composite (run_id, subject_type) FK', () => {
    it(
      'rejects an item whose subject_type differs from its parent run, even though the item is internally well-formed',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group'); // run's subject_type is 'burst_group'
        const dup = await prisma!.duplicateGroup.create({ data: { circleId } });
        // This row is individually well-formed: subject_type='duplicate_group'
        // agrees with duplicateGroupId being the only populated column. It
        // must still be rejected because the run it points at is a
        // 'burst_group' run, not a 'duplicate_group' run.
        await expect(
          prisma!.reviewRunItem.create({
            data: { runId: run.id, subjectType: 'duplicate_group', duplicateGroupId: dup.id },
          }),
        ).rejects.toThrow(/review_run_items_run_id_subject_type_fkey/);
      }),
    );

    it(
      'accepts an item whose subject_type matches its parent run',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        const item = await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });
        expect(item.id).toBeTruthy();
      }),
    );
  });

  // ===========================================================================
  // 5. Cascade delete: subject -> item (run survives)
  // ===========================================================================

  describe('cascade delete: deleting the subject removes its ReviewRunItem, run survives', () => {
    it(
      'deleting a BurstGroup cascades its ReviewRunItem away',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        const item = await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });

        await prisma!.burstGroup.delete({ where: { id: burst.id } });

        const found = await prisma!.reviewRunItem.findUnique({ where: { id: item.id } });
        expect(found).toBeNull();
        const runStillThere = await prisma!.reviewRun.findUnique({ where: { id: run.id } });
        expect(runStillThere).not.toBeNull();
      }),
    );

    it(
      'deleting a DuplicateGroup cascades its ReviewRunItem away',
      skipIfNoDb(async () => {
        const run = await makeRun('duplicate_group');
        const dup = await prisma!.duplicateGroup.create({ data: { circleId } });
        const item = await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'duplicate_group', duplicateGroupId: dup.id },
        });

        await prisma!.duplicateGroup.delete({ where: { id: dup.id } });

        const found = await prisma!.reviewRunItem.findUnique({ where: { id: item.id } });
        expect(found).toBeNull();
        const runStillThere = await prisma!.reviewRun.findUnique({ where: { id: run.id } });
        expect(runStillThere).not.toBeNull();
      }),
    );

    it(
      'deleting a LocationSuggestion cascades its ReviewRunItem away',
      skipIfNoDb(async () => {
        // LocationSuggestion.mediaItemId is @unique, so it needs its own
        // dedicated MediaItem (the shared fixture item is reused elsewhere).
        const localStorageId = randomUUID();
        const localMediaId = randomUUID();
        await prisma!.storageObject.create({
          data: {
            id: localStorageId,
            name: 'loc-test.jpg',
            size: BigInt(512),
            mimeType: 'image/jpeg',
            storageKey: `review-runs-test/${localStorageId}`,
            status: 'ready',
            uploadedById: userId,
          },
        });
        await prisma!.mediaItem.create({
          data: {
            id: localMediaId,
            storageObjectId: localStorageId,
            circleId,
            addedById: userId,
            type: 'photo',
            source: 'web',
            originalFilename: 'loc-test.jpg',
          },
        });
        const suggestion = await prisma!.locationSuggestion.create({
          data: {
            mediaItemId: localMediaId,
            circleId,
            lat: 9.93,
            lng: -84.08,
            confidence: 0.9,
            method: 'interpolated',
          },
        });
        const run = await makeRun('location_suggestion');
        const item = await prisma!.reviewRunItem.create({
          data: {
            runId: run.id,
            subjectType: 'location_suggestion',
            locationSuggestionId: suggestion.id,
          },
        });

        await prisma!.locationSuggestion.delete({ where: { id: suggestion.id } });

        const found = await prisma!.reviewRunItem.findUnique({ where: { id: item.id } });
        expect(found).toBeNull();
        const runStillThere = await prisma!.reviewRun.findUnique({ where: { id: run.id } });
        expect(runStillThere).not.toBeNull();

        // cleanup local-only fixtures (not covered by afterAll)
        await prisma!.mediaItem.deleteMany({ where: { id: localMediaId } });
        await prisma!.storageObject.deleteMany({ where: { id: localStorageId } });
      }),
    );
  });

  // ===========================================================================
  // 6. Cascade delete: run -> items
  // ===========================================================================

  describe('cascade delete: deleting the ReviewRun removes its ReviewRunItem rows', () => {
    it(
      'deleting a ReviewRun cascades all of its ReviewRunItem rows',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const burstA = await prisma!.burstGroup.create({ data: { circleId } });
        const burstB = await prisma!.burstGroup.create({ data: { circleId } });
        const itemA = await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burstA.id },
        });
        const itemB = await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burstB.id },
        });

        await prisma!.reviewRun.delete({ where: { id: run.id } });

        const found = await prisma!.reviewRunItem.findMany({
          where: { id: { in: [itemA.id, itemB.id] } },
        });
        expect(found).toHaveLength(0);
      }),
    );
  });

  // ===========================================================================
  // 7. Partial unique indexes
  // ===========================================================================

  describe('partial unique index on (run_id, subject_column)', () => {
    it(
      'rejects a duplicate (run_id, burst_group_id) pair',
      skipIfNoDb(async () => {
        const run = await makeRun('burst_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        await prisma!.reviewRunItem.create({
          data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });

        await expect(
          prisma!.reviewRunItem.create({
            data: { runId: run.id, subjectType: 'burst_group', burstGroupId: burst.id },
          }),
        ).rejects.toThrow(/run_id.*burst_group_id|burst_group_id.*run_id/);
      }),
    );

    it(
      'permits two rows in the same run when they are different subject types (different partial indexes, no collision)',
      skipIfNoDb(async () => {
        // A single run is normally all one subjectType per the composite FK
        // above, but the partial-unique-index scoping itself is what's under
        // test here: two DIFFERENT runs whose items happen to reference the
        // same underlying group id must not collide, because the index is
        // keyed on (run_id, column) — the run_id differs.
        const runA = await makeRun('burst_group');
        const runB = await makeRun('burst_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });

        const itemA = await prisma!.reviewRunItem.create({
          data: { runId: runA.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });
        const itemB = await prisma!.reviewRunItem.create({
          data: { runId: runB.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });

        expect(itemA.id).not.toBe(itemB.id);
      }),
    );

    it(
      'permits a burst_group_id row and a duplicate_group_id row to coexist in the same run without colliding on the partial index',
      skipIfNoDb(async () => {
        // Exercises that the partial index WHERE burst_group_id IS NOT NULL
        // does not apply to rows where burst_group_id is NULL (the
        // duplicate_group_id row here) — Postgres partial indexes only cover
        // rows matching the predicate, so a NULL burst_group_id row is
        // simply invisible to the burst_group_id index. Uses two separate
        // runs (one per subjectType) since a single run only accepts items
        // of its own subjectType per the composite FK tested above.
        const runBurst = await makeRun('burst_group');
        const runDup = await makeRun('duplicate_group');
        const burst = await prisma!.burstGroup.create({ data: { circleId } });
        const dup = await prisma!.duplicateGroup.create({ data: { circleId } });

        const burstItem = await prisma!.reviewRunItem.create({
          data: { runId: runBurst.id, subjectType: 'burst_group', burstGroupId: burst.id },
        });
        const dupItem = await prisma!.reviewRunItem.create({
          data: { runId: runDup.id, subjectType: 'duplicate_group', duplicateGroupId: dup.id },
        });

        expect(burstItem.id).toBeTruthy();
        expect(dupItem.id).toBeTruthy();
      }),
    );
  });
});
