import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { UploadEnrichmentRegistry } from '../enrichment-fanout/upload-enrichment.registry.js';
import type { UploadEnrichmentService } from '../enrichment-fanout/upload-enrichment.service.js';
import type { MediaSyncService } from '../media-sync/media-sync.service.js';
import type { UploadNotificationService } from '../producers/upload-notification.service.js';
import type { MediaTouchService } from '../touch/media-touch.service.js';

// =============================================================================
// describeMediaSliceConformance (RETRO-J5, #613)
// =============================================================================
//
// The executable proof that the media slice behaves the same wherever it is hosted. The package
// runs it against its in-memory fakes; the web app runs it over its own port adapters
// (`apps/api/test/media/media-slice-conformance.spec.ts`); a bare host runs it over its own.
// Test-runner neutral: the caller hands over `describe`, `it` and `expect`.
//
// Each section covers one guarantee of the slice. A section needs the service from the host plus
// the few hooks the kit cannot invent (how to read what was written); a section a host leaves out is
// skipped, never silently passed.
//
//   touch      the sidecar `updated_at` propagation node backup depends on: de-duplicated, chunked at
//              500 ids, and best-effort (a failed write never reaches the caller);
//   fan-out    the upload enrichment registry: ascending order, a skip reason and its fallback, a
//              trashed item never enqueued, a failing registration never failing the upload;
//   upload     `upload_completed` folds a bulk import into ONE counted write per recipient and window,
//              under the permanent event key, for the uploader and every other member of any role;
//   media sync registration and check-in are PAT-only (a session token is `400 PAT_REQUIRED`) and a
//              device that is not the caller's is a 404, never a 403.
// =============================================================================

/**
 * The touch service and a way to read the id batches it wrote.
 *
 * @stability experimental
 */
export interface MediaTouchUnderTest {
  /** The service. */
  service: MediaTouchService;
  /** The id batches the service wrote with `updateMany`, in order. */
  writtenBatches(): string[][];
  /** Makes the next write fail; the rule asserts the caller never sees it. */
  failNextWrite(): void;
}

/**
 * The fan-out registry and the service that walks it.
 *
 * @stability experimental
 */
export interface MediaFanoutUnderTest {
  /** The registry. */
  registry: UploadEnrichmentRegistry;
  /** The service. */
  service: UploadEnrichmentService;
}

/**
 * The upload producer and a way to read the counted writes it made.
 *
 * @stability experimental
 */
export interface MediaUploadUnderTest {
  /** The producer. */
  service: UploadNotificationService;
  /** Seeds a library and its members; the first member is the uploader. */
  seedLibrary(libraryId: string, members: ReadonlyArray<{ userId: string; role: 'viewer' | 'editor' | 'admin' }>): void | Promise<void>;
  /**
   * The counted notification writes made so far. A host whose port detaches the write (the web
   * edition's does) waits for it to land before answering.
   */
  countedWrites():
    | Array<{ eventKey: string; userId: string; scopeId: string | null | undefined; windowMs: number | null | undefined }>
    | Promise<Array<{ eventKey: string; userId: string; scopeId: string | null | undefined; windowMs: number | null | undefined }>>;
}

/**
 * The Media Sync device service.
 *
 * @stability experimental
 */
export interface MediaSyncUnderTest {
  /** The service. */
  service: MediaSyncService;
}

/**
 * What the kit runs against; a section left out is skipped.
 *
 * @stability experimental
 */
export interface MediaSliceUnderTest {
  /** The touch section. */
  touch?: MediaTouchUnderTest;
  /** The fan-out section. */
  fanout?: MediaFanoutUnderTest;
  /** The upload-producer section. */
  upload?: MediaUploadUnderTest;
  /** The media-sync section. */
  mediaSync?: MediaSyncUnderTest;
}

/**
 * Options of {@link describeMediaSliceConformance}.
 *
 * @stability experimental
 */
export interface MediaSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh set of services; called before each rule so state never leaks between rules. */
  create(): MediaSliceUnderTest | Promise<MediaSliceUnderTest>;
}

/**
 * Runs the media slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeMediaSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: MediaSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`media slice conformance: ${options.name}`, () => {
    describe('touch', () => {
      it('de-duplicates ids and splits at 500 per write', async () => {
        const { touch } = await options.create();
        if (!touch) return;
        const ids = Array.from({ length: 501 }, (_, i) => `m-${i}`);

        await touch.service.touchMediaItems([...ids, ...ids]);

        expect(touch.writtenBatches().map((batch) => batch.length)).toEqual([500, 1]);
      });

      it('writes nothing for an empty list', async () => {
        const { touch } = await options.create();
        if (!touch) return;

        await touch.service.touchMediaItems([]);

        expect(touch.writtenBatches()).toEqual([]);
      });

      it('is best-effort: a failed write never reaches the caller', async () => {
        const { touch } = await options.create();
        if (!touch) return;
        touch.failNextWrite();

        await expect(touch.service.touchMediaItems(['m-1'])).resolves.toBeUndefined();
      });
    });

    describe('upload enrichment fan-out', () => {
      const photo = { id: 'm1', type: 'photo', circleId: 'lib-1', deletedAt: null };

      it('runs the registrations in ascending order and runs the fallback of a skipped one', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        const log: string[] = [];
        fanout.registry.register('late', { mediaTypes: ['photo'], order: 20, skipReason: () => null, enqueue: async () => (log.push('late'), 'job=late') });
        fanout.registry.register('early', { mediaTypes: ['photo'], order: 10, skipReason: () => null, enqueue: async () => (log.push('early'), 'job=early') });
        fanout.registry.register('off', {
          mediaTypes: ['photo'],
          order: 15,
          skipReason: () => 'feature disabled',
          enqueue: async () => 'job=off',
          onSkipped: async () => {
            log.push('fallback');
          },
        });

        await fanout.service.enqueueUploadEnrichment(photo);

        expect(log).toEqual(['early', 'fallback', 'late']);
      });

      it('never enqueues for a trashed item', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        const enqueue = callCounter();
        fanout.registry.register('x', { mediaTypes: ['photo'], skipReason: () => null, enqueue: async () => (enqueue.calls++, 'job=x') });

        await fanout.service.enqueueUploadEnrichment({ ...photo, deletedAt: new Date() });

        expect(enqueue.calls).toBe(0);
      });

      it('never rethrows: a failing registration does not fail the upload', async () => {
        const { fanout } = await options.create();
        if (!fanout) return;
        fanout.registry.register('boom', { mediaTypes: ['photo'], skipReason: () => null, enqueue: async () => { throw new Error('queue down'); } });

        await expect(fanout.service.enqueueUploadEnrichment(photo)).resolves.toBeUndefined();
      });
    });

    describe('upload_completed', () => {
      it('folds a bulk import into one counted write per recipient and window, for every role', async () => {
        const { upload } = await options.create();
        if (!upload) return;
        await upload.seedLibrary('lib-1', [
          { userId: 'uploader', role: 'editor' },
          { userId: 'viewer', role: 'viewer' },
          { userId: 'admin', role: 'admin' },
        ]);

        for (let i = 0; i < 25; i++) await upload.service.recordUpload({ circleId: 'lib-1', uploaderId: 'uploader' });

        const writes = await upload.countedWrites();
        expect(new Set(writes.map((w) => w.userId))).toEqual(new Set(['uploader', 'viewer', 'admin']));
        expect(writes).toHaveLength(75); // one counted write per file per recipient; the host folds them into one row each
        for (const write of writes) {
          expect(write.eventKey).toBe('media.upload_completed');
          expect(write.scopeId).toBe('lib-1');
          expect(write.windowMs).toBe(15 * 60 * 1000);
        }
      });

      it('writes nothing for a library that no longer exists', async () => {
        const { upload } = await options.create();
        if (!upload) return;

        await upload.service.recordUpload({ circleId: 'gone', uploaderId: 'uploader' });

        expect(await upload.countedWrites()).toEqual([]);
      });
    });

    describe('media sync', () => {
      const input = { installationId: '11111111-1111-4111-8111-111111111111', name: 'Phone A' };

      it('registration with a session token is 400 PAT_REQUIRED', async () => {
        const { mediaSync } = await options.create();
        if (!mediaSync) return;

        const error = await mediaSync.service.register('user-1', input as never, { kind: 'jwt' }).catch((e: unknown) => e);

        expect(refusal(error)).toEqual({ status: 400, reason: 'PAT_REQUIRED' });
      });

      it('a check-in with a session token is 400 PAT_REQUIRED', async () => {
        const { mediaSync } = await options.create();
        if (!mediaSync) return;

        const error = await mediaSync.service.checkin('user-1', 'device-1', {} as never, { kind: 'jwt' }).catch((e: unknown) => e);

        expect(refusal(error)).toEqual({ status: 400, reason: 'PAT_REQUIRED' });
      });

      it("another user's device is a 404, never a 403", async () => {
        const { mediaSync } = await options.create();
        if (!mediaSync) return;

        const error = await mediaSync.service.get('user-1', 'someone-elses-device').catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(404);
      });
    });
  });
}

/** A call counter, so the kit needs no mocking library. */
function callCounter(): { calls: number } {
  return { calls: 0 };
}

/** The status and `details.reason` of a refusal thrown by the slice. */
function refusal(error: unknown): { status: number | undefined; reason: string | undefined } {
  const http = error as { getStatus?: () => number; getResponse?: () => { details?: { reason?: string } } };
  return { status: http.getStatus?.(), reason: http.getResponse?.()?.details?.reason };
}
