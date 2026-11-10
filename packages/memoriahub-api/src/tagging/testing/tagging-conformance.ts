import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { MemoriahubJobHandler } from '../../ports/index.js';
import type { UploadEnrichmentRegistry, UploadEnrichmentService } from '../../media/index.js';
import type { AutoTaggingService } from '../auto-tagging.service.js';
import type { TagLabelsService } from '../tag-labels.service.js';
import type { TaggingBackfillService } from '../tagging-backfill.service.js';
import type { FakeMediaItemRow, FakeTaggingStore } from './fake-tagging-db.js';

// =============================================================================
// describeTaggingSliceConformance (RETRO-J7, #618)
// =============================================================================
//
// The executable proof that the tagging slice behaves the same wherever it is hosted. The package
// runs it against its in-memory fakes; the web app runs it over its own port adapters
// (`apps/api/test/tagging/tagging-slice-conformance.spec.ts`); a bare host runs it over its own.
// Test-runner neutral: the caller hands over `describe`, `it` and `expect`.
//
//   persist       the single vocabulary validator both job types share: only labels of the admin's
//                 vocabulary become tags (case normalised, the rest dropped), a re-run replaces the AI
//                 tags and never touches a manual one, the description is written only for an answer
//                 that parses;
//   jobs          both job types are SERVER-ONLY (a provider key is never brokered to a node: `usesAi`
//                 and no node result pair), keep their permanent type strings, profiles and the shared
//                 `tagging` throttle bucket, and register through the jobs port;
//   fan-out       a photo upload enqueues `auto_tagging` at priority 20 with the `pending` status behind
//                 `features.autoTagging`; a video upload enqueues nothing from this registration;
//   backfill      photos by default, videos only when asked, each routed by its own type;
//   vocabulary    a label name is unique (a duplicate is a conflict, never a second row).
//
// A section a host leaves out is skipped, never silently passed.
// =============================================================================

/**
 * The persist half and the state it writes.
 *
 * @stability experimental
 */
export interface TaggingPersistUnderTest {
  /** The service. */
  service: AutoTaggingService;
  /** The in-memory store behind the database port (or a host's view of its own). */
  store: FakeTaggingStore;
}

/**
 * The two handlers and a way to ask the jobs port whether they registered.
 *
 * @stability experimental
 */
export interface TaggingJobsUnderTest {
  /** The photo and video handlers. */
  handlers: MemoriahubJobHandler[];
  /** Whether the jobs port holds a handler for the type (after the module initialised). */
  registered(type: string): boolean;
}

/**
 * The upload fan-out registry, the service that walks it and the hooks the rules read.
 *
 * @stability experimental
 */
export interface TaggingFanoutUnderTest {
  /** The registry. */
  registry: UploadEnrichmentRegistry;
  /** The service. */
  service: UploadEnrichmentService;
  /** The store, to read the tag status. */
  store: FakeTaggingStore;
  /** Turns `features.autoTagging` on or off. */
  setAutoTagging(on: boolean): void | Promise<void>;
  /** The jobs enqueued so far. */
  enqueued(): Array<{ type: string; priority?: number; subjectId?: string; reason?: string }>;
}

/**
 * The backfill service and the hooks the rules read.
 *
 * @stability experimental
 */
export interface TaggingBackfillUnderTest {
  /** The service. */
  service: TaggingBackfillService;
  /** The store the items are seeded in. */
  store: FakeTaggingStore;
  /** The jobs enqueued so far. */
  enqueued(): Array<{ type: string; reason?: string }>;
}

/**
 * The vocabulary service.
 *
 * @stability experimental
 */
export interface TaggingVocabularyUnderTest {
  /** The service. */
  service: TagLabelsService;
}

/**
 * What the kit runs against; a section left out is skipped.
 *
 * @stability experimental
 */
export interface TaggingSliceUnderTest {
  /** The persist section. */
  persist?: TaggingPersistUnderTest;
  /** The jobs section. */
  jobs?: TaggingJobsUnderTest;
  /** The fan-out section. */
  fanout?: TaggingFanoutUnderTest;
  /** The backfill section. */
  backfill?: TaggingBackfillUnderTest;
  /** The vocabulary section. */
  vocabulary?: TaggingVocabularyUnderTest;
}

/**
 * Options of {@link describeTaggingSliceConformance}.
 *
 * @stability experimental
 */
export interface TaggingSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh set of services; called before each rule so state never leaks between rules. */
  create(): TaggingSliceUnderTest | Promise<TaggingSliceUnderTest>;
}

const USED = { providerKey: 'openai', modelVersion: 'model-a' };
const photo = (id = 'm1', circleId = 'lib-1'): FakeMediaItemRow => ({ id, circleId, type: 'photo', addedById: 'user-1' });

/**
 * Runs the tagging slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeTaggingSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: TaggingSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`tagging slice conformance: ${options.name}`, () => {
    describe('persist (the single vocabulary validator)', () => {
      it('keeps only labels of the vocabulary, normalises their case and drops the rest', async () => {
        const { persist } = await options.create();
        if (!persist) return;
        const item = photo();
        persist.store.items.set(item.id, item);
        persist.store.addLabel('Beach');
        persist.store.addLabel('Sunset');

        await persist.service.persistAutoTagging(
          { id: 'job-1', mediaItemId: item.id, circleId: item.circleId },
          { rawText: JSON.stringify({ tags: ['beach', 'SUNSET', 'Not In The List'], description: 'Sun and water.' }) },
          USED,
        );

        expect(persist.store.tagsOf(item.id)).toEqual([
          { name: 'Beach', source: 'ai' },
          { name: 'Sunset', source: 'ai' },
        ]);
      });

      it('never offers a disabled label to the model, so it can never become a tag', async () => {
        const { persist } = await options.create();
        if (!persist) return;
        const item = photo();
        persist.store.items.set(item.id, item);
        persist.store.addLabel('Beach');
        persist.store.addLabel('Retired', false);

        await persist.service.persistAutoTagging(
          { id: 'job-1', mediaItemId: item.id, circleId: item.circleId },
          { rawText: JSON.stringify({ tags: ['Beach', 'Retired'], description: 'x' }) },
          USED,
        );

        expect(persist.store.tagsOf(item.id).map((tag) => tag.name)).toEqual(['Beach']);
      });

      it('a re-run replaces the AI tags and never removes or downgrades a manual one', async () => {
        const { persist } = await options.create();
        if (!persist) return;
        const item = photo();
        persist.store.items.set(item.id, item);
        persist.store.addLabel('Beach');
        persist.store.addLabel('Sunset');
        persist.store.addTag(item, 'Sunset', 'manual');
        persist.store.addTag(item, 'Old Ai Tag', 'ai');

        await persist.service.persistAutoTagging(
          { id: 'job-1', mediaItemId: item.id, circleId: item.circleId },
          { rawText: JSON.stringify({ tags: ['Beach', 'Sunset'], description: 'x' }) },
          USED,
        );

        expect(persist.store.tagsOf(item.id)).toEqual([
          { name: 'Beach', source: 'ai' },
          { name: 'Sunset', source: 'manual' },
        ]);
      });

      it('writes the description only when the answer parses, and still marks the item processed', async () => {
        const { persist } = await options.create();
        if (!persist) return;
        const item = { ...photo(), description: 'kept' };
        persist.store.items.set(item.id, item);
        persist.store.addLabel('Beach');

        await persist.service.persistAutoTagging(
          { id: 'job-1', mediaItemId: item.id, circleId: item.circleId },
          { rawText: 'not json at all' },
          USED,
        );

        expect(persist.store.items.get(item.id)?.description).toBe('kept');
        expect(persist.store.statuses.get(item.id)).toMatchObject({ status: 'processed', tagCount: 0, providerKey: 'openai' });
      });
    });

    describe('jobs', () => {
      it('both job types are server-only: usesAi, no node result pair', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;

        expect(jobs.handlers.map((handler) => handler.type).sort()).toEqual(['auto_tagging', 'video_auto_tagging']);
        for (const handler of jobs.handlers) {
          expect(handler.usesAi).toBe(true);
          expect(handler.nodeResultSchema).toBeUndefined();
          expect(handler.persistNodeResult).toBeUndefined();
        }
      });

      it('keeps the permanent profiles and the shared `tagging` throttle bucket', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;

        const byType = Object.fromEntries(jobs.handlers.map((handler) => [handler.type, handler]));
        expect(byType['auto_tagging']?.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 3 });
        expect(byType['video_auto_tagging']?.profile).toEqual({ maxRuntimeMs: 1_200_000, maxAttempts: 3 });
        expect(byType['auto_tagging']?.throttleKey).toBe('tagging');
        expect(byType['video_auto_tagging']?.throttleKey).toBe('tagging');
      });

      it('registers both handlers through the jobs port', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;

        expect(jobs.registered('auto_tagging')).toBe(true);
        expect(jobs.registered('video_auto_tagging')).toBe(true);
      });
    });

    describe('upload enrichment fan-out', () => {
      it('a photo enqueues auto_tagging at priority 20 and is marked pending, behind features.autoTagging', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        await fanout.setAutoTagging(true);

        await fanout.service.enqueueUploadEnrichment({ id: 'm1', type: 'photo', circleId: 'lib-1', deletedAt: null });

        expect(
          fanout
            .enqueued()
            .filter((job) => job.type === 'auto_tagging')
            .map(({ type, priority, subjectId, reason }) => ({ type, priority, subjectId, reason })),
        ).toEqual([{ type: 'auto_tagging', priority: 20, subjectId: 'm1', reason: 'upload' }]);
        expect(fanout.store.statuses.get('m1')).toMatchObject({ status: 'pending' });
      });

      it('enqueues nothing while the feature is off', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        await fanout.setAutoTagging(false);

        await fanout.service.enqueueUploadEnrichment({ id: 'm1', type: 'photo', circleId: 'lib-1', deletedAt: null });

        expect(fanout.enqueued().filter((job) => job.type === 'auto_tagging')).toEqual([]);
      });

      it('a video enqueues nothing from this registration (video tagging rides the post-detection fan-out)', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        await fanout.setAutoTagging(true);

        await fanout.service.enqueueUploadEnrichment({ id: 'v1', type: 'video', circleId: 'lib-1', deletedAt: null });

        expect(fanout.enqueued().filter((job) => job.type === 'auto_tagging' || job.type === 'video_auto_tagging')).toEqual([]);
      });
    });

    describe('backfill', () => {
      it('backfills photos only by default; videos are opt-in', async () => {
        const { backfill } = await options.create();
        if (!backfill) return;
        backfill.store.items.set('p1', photo('p1', 'lib-1'));
        backfill.store.items.set('v1', { id: 'v1', circleId: 'lib-1', type: 'video' });

        await backfill.service.backfillCircle('lib-1', {});

        expect(backfill.enqueued().map((job) => job.type)).toEqual(['auto_tagging']);
      });

      it('routes each item by its own type when videos are asked for, at backfill priority', async () => {
        const { backfill } = await options.create();
        if (!backfill) return;
        backfill.store.items.set('p1', photo('p1', 'lib-1'));
        backfill.store.items.set('v1', { id: 'v1', circleId: 'lib-1', type: 'video' });

        await backfill.service.backfillCircle('lib-1', { mediaTypes: ['photo', 'video'] });

        expect(backfill.enqueued().map((job) => job.type).sort()).toEqual(['auto_tagging', 'video_auto_tagging']);
        expect(backfill.enqueued().every((job) => job.reason === 'backfill')).toBe(true);
      });
    });

    describe('vocabulary', () => {
      it('a duplicate label name is a conflict, never a second row', async () => {
        const { vocabulary } = await options.create();
        if (!vocabulary) return;
        await vocabulary.service.create({ name: 'Beach' } as never);

        const error = await vocabulary.service.create({ name: 'Beach' } as never).catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(409);
        expect(await vocabulary.service.getAll()).toHaveLength(1);
      });
    });
  });
}
