import type { MemoriahubConformanceHarness } from '../../testing/index.js';

// =============================================================================
// describeMemoriesSliceConformance (RETRO-J8, #619)
// =============================================================================
//
// The executable proof of the memories slice's job registration. Test-runner neutral.
//
//   types       `memory_generation` and `memory_digest` are registered under exactly these strings
//               (a job type string is permanent once jobs of that type exist).
//   server-only neither declares `nodeResultSchema` or `persistNodeResult`: the generation job needs a
//               model credential and the digest an e-mail credential and a signing key, none of which
//               a worker node may hold.
//
// BEHAVIOUR (optional, `options.behaviour`): the rules a registration check cannot reach, run on the host's
// real data path. Registered only when a host supplies the handles (a host over in-memory fakes has no data
// path to prove them on).
//
//   tombstone   upserting the same (library, type, period, subject) twice is one row, and a memory a member
//               deleted is never resurrected, refreshed or duplicated by a later generation pass.
//   watermark   the digest watermark is the newest SUCCEEDED `memory_digest` job's `finishedAt` of that
//               library: a failed job, a running job and another library's job never move it.
//   read-time   per-user preferences (hidden people) filter what a member SEES; they never change what is
//               generated, so the rows (and the other members' view) are identical with and without them.
// =============================================================================

/**
 * What the kit runs against: the handlers the slice registered with the queue.
 *
 * @stability experimental
 */
export interface MemoriesSliceUnderTest {
  /** The registered job handlers (type and optional node members are read). */
  handlers: ReadonlyArray<{
    type: string;
    nodeResultSchema?: unknown;
    persistNodeResult?: unknown;
    profile?: { maxRuntimeMs: number; maxAttempts: number };
  }>;
}

/**
 * One library's seeded world, as the behaviour rules need it.
 *
 * @stability experimental
 */
export interface MemoriesBehaviourWorld {
  /** The library (owner scope) the memories live in. */
  libraryId: string;
  /** Two members who can read it. */
  userId: string;
  otherUserId: string;
  /** Live media items of the library, to select into memories. */
  mediaItemIds: string[];
  /** A person of the library, for a person-scoped memory. */
  personId: string;
}

/**
 * The host's real data path, as handles. Every method runs against the host's database.
 *
 * @stability experimental
 */
export interface MemoriesBehaviourUnderTest {
  /** Seeds a fresh, isolated library; called once per rule. */
  seedWorld(): Promise<MemoriesBehaviourWorld>;
  /** The curation upsert every curator funnels through (template titles only). */
  upsertMemory(input: {
    libraryId: string;
    type: 'on_this_day' | 'trip' | 'person_highlights';
    periodKey: string;
    subjectKey?: string;
    title: string;
    mediaItemIds: string[];
    personId?: string | null;
  }): Promise<{ memoryId: string | null; created: boolean; skippedTombstone: boolean }>;
  /** A member deletes a memory (the circle-level tombstone). */
  deleteMemory(memoryId: string, userId: string): Promise<void>;
  /** Every row of the identity, tombstoned ones included. */
  memoryRows(libraryId: string): Promise<Array<{ id: string; type: string; periodKey: string; deletedAt: Date | null; itemCount: number; title: string; refreshedAt: Date }>>;
  /** The ids the member sees in the memory list. */
  listFor(userId: string, libraryId: string): Promise<string[]>;
  /** Stores the member's `memories` preferences (hidden people; empty clears them). */
  setPreferences(userId: string, prefs: { hiddenPersonIds?: string[] }): Promise<void>;
  /** Records a `memory_digest` job of the library in the given state. */
  recordDigestJob(libraryId: string, status: 'succeeded' | 'failed' | 'running', finishedAt: Date | null): Promise<void>;
  /** The digest watermark of the library. */
  digestWatermark(libraryId: string): Promise<Date | null>;
}

/**
 * Options of {@link describeMemoriesSliceConformance}.
 *
 * @stability experimental
 */
export interface MemoriesSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): MemoriesSliceUnderTest | Promise<MemoriesSliceUnderTest>;
  /** The host's data path; when given, the behaviour rules run too. */
  behaviour?: () => MemoriesBehaviourUnderTest | Promise<MemoriesBehaviourUnderTest>;
}

/**
 * Runs the memories slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeMemoriesSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: MemoriesSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const MEMORY_TYPES = ['memory_digest', 'memory_generation'];

  describe(`memories slice conformance: ${options.name}`, () => {
    it('registers exactly the two memory job types under their permanent strings', async () => {
      const slice = await options.create();
      const types = slice.handlers.map((h) => h.type).filter((t) => t.startsWith('memory_')).sort();
      expect(types).toEqual(MEMORY_TYPES);
    });

    it('keeps both server-only (no node result schema, no node persist)', async () => {
      const slice = await options.create();
      for (const handler of slice.handlers.filter((h) => MEMORY_TYPES.includes(h.type))) {
        expect(handler.nodeResultSchema).toBeUndefined();
        expect(handler.persistNodeResult).toBeUndefined();
      }
    });

    it('declares an execution profile for each', async () => {
      const slice = await options.create();
      const profiles = Object.fromEntries(
        slice.handlers.filter((h) => MEMORY_TYPES.includes(h.type)).map((h) => [h.type, h.profile]),
      );
      expect(profiles).toEqual({
        memory_generation: { maxRuntimeMs: 1_200_000, maxAttempts: 3 },
        memory_digest: { maxRuntimeMs: 900_000, maxAttempts: 2 },
      });
    });

    if (options.behaviour) registerBehaviourRules(harness, options.behaviour);
  });
}

function registerBehaviourRules(
  harness: MemoriahubConformanceHarness,
  behaviour: NonNullable<MemoriesSliceConformanceOptions['behaviour']>,
): void {
  const { describe, it, expect } = harness;

  describe('behaviour on the host data path', () => {
    it('upserting one identity twice is one row, refreshed in place', async () => {
      const host = await behaviour();
      const w = await host.seedWorld();
      const base = { libraryId: w.libraryId, type: 'on_this_day' as const, periodKey: '2026-11-12', subjectKey: '2024', title: 'On this day' };

      const first = await host.upsertMemory({ ...base, mediaItemIds: w.mediaItemIds.slice(0, 2) });
      const second = await host.upsertMemory({ ...base, mediaItemIds: w.mediaItemIds.slice(0, 2) });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.memoryId).toBe(first.memoryId);
      expect(second.skippedTombstone).toBe(false);
      expect(await host.memoryRows(w.libraryId)).toHaveLength(1);
    });

    it('never resurrects, refreshes or duplicates a memory a member deleted', async () => {
      const host = await behaviour();
      const w = await host.seedWorld();
      const input = { libraryId: w.libraryId, type: 'trip' as const, periodKey: '2026-08-01', subjectKey: 'lisbon', title: 'Trip to Place A' };

      const created = await host.upsertMemory({ ...input, mediaItemIds: w.mediaItemIds.slice(0, 2) });
      await host.deleteMemory(created.memoryId!, w.userId);
      const [tombstone] = await host.memoryRows(w.libraryId);
      expect(tombstone!.deletedAt).not.toBeNull();

      const again = await host.upsertMemory({ ...input, title: 'A new title', mediaItemIds: w.mediaItemIds });

      expect(again).toEqual({ memoryId: null, created: false, skippedTombstone: true });
      const rows = await host.memoryRows(w.libraryId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(created.memoryId);
      expect(rows[0]!.deletedAt).not.toBeNull();
      expect(rows[0]!.title).toBe('Trip to Place A');
      expect(rows[0]!.itemCount).toBe(2);
      expect(rows[0]!.refreshedAt.getTime()).toBe(tombstone!.refreshedAt.getTime());
      expect(await host.listFor(w.userId, w.libraryId)).toEqual([]);
    });

    it('keeps the digest watermark at the newest succeeded digest job of that library', async () => {
      const host = await behaviour();
      const w = await host.seedWorld();
      const other = await host.seedWorld();
      expect(await host.digestWatermark(w.libraryId)).toBeNull();

      const older = new Date('2026-10-01T08:00:00.000Z');
      const newer = new Date('2026-10-08T08:00:00.000Z');
      await host.recordDigestJob(w.libraryId, 'succeeded', older);
      expect((await host.digestWatermark(w.libraryId))!.toISOString()).toBe(older.toISOString());

      await host.recordDigestJob(w.libraryId, 'succeeded', newer);
      // None of these is a sent digest: a retry would otherwise skip content nobody was mailed.
      await host.recordDigestJob(w.libraryId, 'failed', new Date('2026-10-20T08:00:00.000Z'));
      await host.recordDigestJob(w.libraryId, 'running', null);
      await host.recordDigestJob(other.libraryId, 'succeeded', new Date('2026-10-25T08:00:00.000Z'));

      expect((await host.digestWatermark(w.libraryId))!.toISOString()).toBe(newer.toISOString());
      expect((await host.digestWatermark(other.libraryId))!.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    });

    it('applies preferences at read time only: the rows and the other members view are unchanged', async () => {
      const host = await behaviour();
      const w = await host.seedWorld();
      const personal = await host.upsertMemory({
        libraryId: w.libraryId, type: 'person_highlights', periodKey: 'all', subjectKey: w.personId,
        title: 'Best of Person A', mediaItemIds: w.mediaItemIds.slice(0, 2), personId: w.personId,
      });
      const day = await host.upsertMemory({
        libraryId: w.libraryId, type: 'on_this_day', periodKey: '2026-11-12', subjectKey: '2023',
        title: 'On this day', mediaItemIds: w.mediaItemIds.slice(0, 2),
      });
      const rowsBefore = await host.memoryRows(w.libraryId);
      const both = [personal.memoryId!, day.memoryId!].sort();
      expect((await host.listFor(w.userId, w.libraryId)).sort()).toEqual(both);

      await host.setPreferences(w.userId, { hiddenPersonIds: [w.personId] });

      expect(await host.listFor(w.userId, w.libraryId)).toEqual([day.memoryId]);
      expect((await host.listFor(w.otherUserId, w.libraryId)).sort()).toEqual(both);
      // Generation ignores preferences: the same upsert refreshes the same hidden-person memory in place.
      const regenerated = await host.upsertMemory({
        libraryId: w.libraryId, type: 'person_highlights', periodKey: 'all', subjectKey: w.personId,
        title: 'Best of Person A', mediaItemIds: w.mediaItemIds.slice(0, 2), personId: w.personId,
      });
      expect(regenerated.created).toBe(false);
      expect(regenerated.memoryId).toBe(personal.memoryId);
      const rowsAfter = await host.memoryRows(w.libraryId);
      expect(rowsAfter.map((r) => [r.id, r.deletedAt, r.itemCount, r.title])).toEqual(
        rowsBefore.map((r) => [r.id, r.deletedAt, r.itemCount, r.title]),
      );

      await host.setPreferences(w.userId, {});
      expect((await host.listFor(w.userId, w.libraryId)).sort()).toEqual(both);
    });
  });
}
