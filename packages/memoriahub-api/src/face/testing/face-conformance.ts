import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { MemoriahubJobHandler } from '../../ports/index.js';
import type { UploadEnrichmentRegistry } from '../../media/index.js';
import type { FaceClusteringService } from '../face-clustering.service.js';
import type { FaceDetectionService } from '../face-detection.service.js';
import type { FaceMatchingService } from '../face-matching.service.js';

// =============================================================================
// describeFaceSliceConformance (RETRO-J6, #615)
// =============================================================================
//
// The executable proof that the face slice behaves the same wherever it is hosted. The package runs
// it against in-memory fakes; the web app runs it over its own port adapters and a real PostgreSQL
// with pgvector (`apps/api/test/face/face-slice-conformance.db.spec.ts`); a bare host runs it over its
// own. Test-runner neutral: the caller hands over `describe`, `it` and `expect`.
//
// Each section covers one guarantee; a section a host leaves out is skipped, never silently passed.
//
//   jobs         the three job types, their execution profile and node eligibility (the two per-item
//                types carry the node result pair; the circle sweep never does), and the photo upload
//                fan-out registered with the media slice;
//   rerun        a re-detection deletes only the detections a person did not label: manual faces
//                survive every rerun;
//   clustering   an archived (hidden) face is never pulled back into a new person;
//   auto-archive the precision gate: a face archives only when it matches an archived face at or
//                above the threshold, and only an archived, unassigned face can be matched;
//   knn          the vector backends agree: `app` (in-process cosine) and `pgvector` (indexed KNN)
//                pick the same person for the same probe and both refuse a stranger.
// =============================================================================

/**
 * A 128-dimension unit vector with its weight on one axis and a little on the next.
 *
 * @stability experimental
 */
export function faceFixtureVector(axis: number, tilt = 0): number[] {
  const v = new Array<number>(128).fill(0);
  v[axis % 128] = 1;
  v[(axis + 1) % 128] = tilt;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / norm);
}

/**
 * The job handlers and the fan-out registry.
 *
 * @stability experimental
 */
export interface FaceJobsUnderTest {
  /** The handlers the slice registered with the queue, by type. */
  handlers: ReadonlyMap<string, MemoriahubJobHandler>;
  /** The media slice's fan-out registry. */
  uploadRegistry: UploadEnrichmentRegistry;
}

/**
 * The persist half of detection and the means to seed and read faces.
 *
 * @stability experimental
 */
export interface FaceRerunUnderTest {
  /** The detection service. */
  service: FaceDetectionService;
  /** The media item the faces belong to. */
  mediaItemId: string;
  /** The circle the media item belongs to. */
  circleId: string;
  /** Seeds faces of the media item; `key` is the logical name the rule reads back through `faceKeys`. */
  seedFaces(faces: ReadonlyArray<{ key: string; manuallyAssigned: boolean }>): void | Promise<void>;
  /** The logical keys of the faces the media item has now. */
  faceKeys(): string[] | Promise<string[]>;
}

/**
 * The clustering service and the means to seed faces.
 *
 * @stability experimental
 */
export interface FaceClusteringUnderTest {
  /** The service. */
  service: FaceClusteringService;
  /** The circle (owner scope) the faces are seeded into. */
  circleId: string;
  /** The user recorded as creator of the new people. */
  userId: string;
  /** Seeds unassigned faces of the circle; `key` is the logical name the rule reads back through `personOf`. */
  seedFaces(faces: ReadonlyArray<{ key: string; embedding: number[]; hidden: boolean }>): void | Promise<void>;
  /** The person (if any) the face with this key ended up in. */
  personOf(key: string): string | null | Promise<string | null>;
}

/**
 * The matching service and the means to seed the archived pool.
 *
 * @stability experimental
 */
export interface FaceAutoArchiveUnderTest {
  /** The service. */
  service: FaceMatchingService;
  /** The circle (owner scope) the faces are seeded into. */
  circleId: string;
  /**
   * Seeds the faces of the circle: an archived unassigned one, a live unassigned one and one assigned to
   * a person, each with the given embedding.
   *
   * @returns the id of the archived unassigned face.
   */
  seedPool(embedding: number[]): string | Promise<string>;
}

/**
 * One vector backend.
 *
 * @stability experimental
 */
export interface FaceKnnBackend {
  /** `app` or `pgvector`. */
  name: string;
  /** The matching service configured for this backend. */
  service: FaceMatchingService;
}

/**
 * The backends to compare and the means to seed three people.
 *
 * @stability experimental
 */
export interface FaceKnnUnderTest {
  /** Every backend the host can run (a host without pgvector gives `app` only). */
  backends: FaceKnnBackend[];
  /** The circle (owner scope) the people are seeded into. */
  circleId: string;
  /** Seeds three people, each with two faces near `faceFixtureVector(2 | 11 | 40)`, returning their ids in that order. */
  seedPeople(): string[] | Promise<string[]>;
}

/**
 * What the kit runs against; a section left out is skipped.
 *
 * @stability experimental
 */
export interface FaceSliceUnderTest {
  /** The jobs section. */
  jobs?: FaceJobsUnderTest;
  /** The rerun section. */
  rerun?: FaceRerunUnderTest;
  /** The clustering section. */
  clustering?: FaceClusteringUnderTest;
  /** The auto-archive section. */
  autoArchive?: FaceAutoArchiveUnderTest;
  /** The knn section. */
  knn?: FaceKnnUnderTest;
}

/**
 * Options of {@link describeFaceSliceConformance}.
 *
 * @stability experimental
 */
export interface FaceSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh set of services; called before each rule so state never leaks between rules. */
  create(): FaceSliceUnderTest | Promise<FaceSliceUnderTest>;
}

/**
 * Runs the face slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeFaceSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: FaceSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`face slice conformance: ${options.name}`, () => {
    describe('jobs', () => {
      it('registers exactly the three face job types, with permanent strings', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;
        expect([...jobs.handlers.keys()].filter((t) => t.startsWith('face') || t.startsWith('video_face')).sort()).toEqual([
          'face_auto_archive_sweep',
          'face_detection',
          'video_face_detection',
        ]);
      });

      it('derives node eligibility from the result pair: per-item jobs carry it, the sweep never does', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;
        for (const type of ['face_detection', 'video_face_detection']) {
          const handler = jobs.handlers.get(type)!;
          expect(handler.nodeResultSchema).toBeDefined();
          expect(handler.persistNodeResult).toBeDefined();
        }
        const sweep = jobs.handlers.get('face_auto_archive_sweep')!;
        expect(sweep.nodeResultSchema).toBeUndefined();
        expect(sweep.persistNodeResult).toBeUndefined();
      });

      it('declares the execution profiles and never a lease or a heartbeat', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;
        expect(jobs.handlers.get('face_detection')!.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
        expect(jobs.handlers.get('face_auto_archive_sweep')!.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 3 });
        const video = jobs.handlers.get('video_face_detection')!.profile!;
        expect(Object.keys(video).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
        expect(video.maxAttempts).toBe(3);
      });

      it('puts the photo job on the face provider throttle bucket', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;
        expect(jobs.handlers.get('face_detection')!.throttleKey).toBe('face');
      });

      it('registers the photo fan-out with the media slice: photos only, after tagging', async () => {
        const { jobs } = await options.create();
        if (!jobs) return;
        const photo = jobs.uploadRegistry.forMediaType('photo').map((r) => r.type);
        const video = jobs.uploadRegistry.forMediaType('video').map((r) => r.type);
        expect(photo).toContain('face_detection');
        expect(video).not.toContain('face_detection');
      });
    });

    describe('rerun', () => {
      it('keeps manually assigned faces and replaces the rest', async () => {
        const { rerun } = await options.create();
        if (!rerun) return;
        await rerun.seedFaces([
          { key: 'manual', manuallyAssigned: true },
          { key: 'detected-1', manuallyAssigned: false },
          { key: 'detected-2', manuallyAssigned: false },
        ]);

        await rerun.service.persistFaces(
          { id: 'job-1', mediaItemId: rerun.mediaItemId, circleId: rerun.circleId },
          { providerKey: 'compreface', modelVersion: 'mobilenet', imageWidth: 100, imageHeight: 100, faces: [] },
        );

        expect(await rerun.faceKeys()).toEqual(['manual']);
      });
    });

    describe('clustering', () => {
      it('never pulls an archived face into a new person', async () => {
        const { clustering } = await options.create();
        if (!clustering) return;
        const live = faceFixtureVector(3);
        await clustering.seedFaces([
          { key: 'live-1', embedding: live, hidden: false },
          { key: 'live-2', embedding: live, hidden: false },
          { key: 'archived-1', embedding: live, hidden: true },
        ]);

        const result = await clustering.service.clusterUnknownFaces(clustering.circleId, clustering.userId);

        expect(result.facesAssigned).toBe(2);
        expect(await clustering.personOf('live-1')).not.toBeNull();
        expect(await clustering.personOf('live-1')).toBe(await clustering.personOf('live-2'));
        expect(await clustering.personOf('archived-1')).toBeNull();
      });
    });

    describe('auto-archive', () => {
      it('archives only on a match at or above the threshold', async () => {
        const { autoArchive } = await options.create();
        if (!autoArchive) return;
        const known = faceFixtureVector(5);
        const archivedFaceId = await autoArchive.seedPool(known);

        const hit = await autoArchive.service.matchFaceToArchived(autoArchive.circleId, known);
        expect(hit?.faceId).toBe(archivedFaceId);

        const stranger = await autoArchive.service.matchFaceToArchived(autoArchive.circleId, faceFixtureVector(60));
        expect(stranger).toBeNull();
      });

      it('matches only the archived, unassigned face of the pool', async () => {
        const { autoArchive } = await options.create();
        if (!autoArchive) return;
        const archivedFaceId = await autoArchive.seedPool(faceFixtureVector(7));

        const hit = await autoArchive.service.matchFaceToArchived(autoArchive.circleId, faceFixtureVector(7));

        expect(hit?.faceId).toBe(archivedFaceId);
      });

      it('answers null for an empty probe', async () => {
        const { autoArchive } = await options.create();
        if (!autoArchive) return;
        expect(await autoArchive.service.matchFaceToArchived(autoArchive.circleId, [])).toBeNull();
      });
    });

    describe('knn', () => {
      it('every backend picks the same person for the same probe', async () => {
        const { knn } = await options.create();
        if (!knn) return;
        const people = await knn.seedPeople();
        const probe = faceFixtureVector(11, 0.05);

        const answers = await Promise.all(knn.backends.map(async (b) => ({ name: b.name, hit: await b.service.matchFaceToPerson(knn.circleId, probe) })));

        for (const answer of answers) {
          expect(answer.hit?.personId).toBe(people[1]);
        }
        const [first, ...rest] = answers;
        for (const other of rest) {
          expect(Math.abs((other.hit?.similarity ?? 0) - (first!.hit?.similarity ?? 0))).toBeLessThan(1e-4);
        }
      });

      it('every backend refuses a stranger', async () => {
        const { knn } = await options.create();
        if (!knn) return;
        await knn.seedPeople();

        for (const backend of knn.backends) {
          expect(await backend.service.matchFaceToPerson(knn.circleId, faceFixtureVector(90))).toBeNull();
        }
      });
    });
  });
}
