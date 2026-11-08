// =============================================================================
// The media/face job handlers against the platform handler contract (RETRO-C3, #585)
// =============================================================================
//
// `describeJobHandlerConformance` (`@marinoscar/platform-api/jobs/testing`) holds
// each handler to the contract every job type shares: a label, a two-number
// profile, node eligibility derived from the schema/persist pair, a settle
// through the queue, an idempotent second run, failure by throwing and the dedup
// rule. The six types here are `face_detection`, `video_face_detection`,
// `face_auto_archive_sweep`, `metadata_extraction`, `thumbnail_regen` and
// `thumbnail_repair`.
//
// ONE RULE IS WAIVED, ON PURPOSE. The kit's static case also requires a DOTTED
// type (`storage.object.process`). MemoriaHub's type strings predate the platform,
// rows of every one of them exist in production, and a type string is permanent
// (`job-type-snapshot.spec.ts`), so `face_detection` stays `face_detection`. The
// static case is therefore replaced here by the same check with exactly that one
// violation filtered out: every other static rule still holds. Seam gap: the kit
// has no option for a fork's legacy, undotted type strings
// (`JobHandlerContractOptions` could take `legacyTypes`).
//
// The behavioural detail of each handler stays in its own spec under `src/`;
// this file is the contract, plus the subject rules the issue asks for: a gone
// subject settles as a no-op, a social-media or over-cap video is skipped
// without a download, and the node results are validated by `nodeResultSchema`.
// =============================================================================

import { JobHandlerRegistry, type JobHandler } from '@marinoscar/platform-api/jobs';
import {
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
} from '@marinoscar/platform-api/jobs/testing';
import type { ConformanceTestApi } from '@marinoscar/platform-api/testing';
import { Readable } from 'stream';

import { FaceAutoArchiveSweepHandler } from '../../src/face/face-auto-archive-sweep.handler';
import { FaceDetectionHandler } from '../../src/face/face-detection.handler';
import { VideoFaceDetectionHandler } from '../../src/face/video-face-detection.handler';
import { VideoFaceDetectionService } from '../../src/face/video-face-detection.service';
import { ThumbnailRegenHandler } from '../../src/media/thumbnail-regen.handler';
import { ThumbnailRepairHandler } from '../../src/media/thumbnail-repair.handler';
import { MetadataExtractionHandler } from '../../src/metadata/metadata.handler';
import { mediaItemJob } from '../helpers/platform-job';

const PHOTO_ID = '00000000-0000-4000-8000-00000000c301';
const VIDEO_ID = '00000000-0000-4000-8000-00000000c302';
const GONE_ID = '00000000-0000-4000-8000-00000000c3ff';
const CIRCLE_ID = '00000000-0000-4000-8000-00000000c3c1';
const OBJECT_ID = '00000000-0000-4000-8000-00000000c3b1';

/** The kit's static-case title, which this file replaces (see the header). */
const STATIC_CASE = 'honours the static contract';

/** Jest, with the kit's static case skipped: `staticContract` below runs it minus the dotted-type rule. */
const legacyTypeTestApi: ConformanceTestApi = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => {
    const run = async () => {
      await fn();
    };
    if (name.startsWith(STATIC_CASE)) it.skip(name, run);
    else it(name, run);
  },
  expect: expect as unknown as ConformanceTestApi['expect'],
};

/** The static contract, minus the one rule a permanent undotted type cannot meet. */
function staticContract(name: string, build: () => JobHandler): void {
  it(`${name}: honours the static contract (except the dotted type: the string is permanent)`, () => {
    const handler = build();
    const violations = findJobHandlerContractViolations(handler).filter(
      (v) => !v.includes('the type must be dotted'),
    );
    expect(violations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// One stateful fake world: the media items and circles that exist, and every
// write a handler made. A fresh world per test (`reset` in each scenario).
// ---------------------------------------------------------------------------

interface World {
  mediaItems: Map<string, { id: string; circleId: string }>;
  circles: Set<string>;
  writes: Map<string, unknown>;
  downloads: number;
}

let world: World;

function reset(): void {
  world = {
    mediaItems: new Map([
      [PHOTO_ID, { id: PHOTO_ID, circleId: CIRCLE_ID }],
      [VIDEO_ID, { id: VIDEO_ID, circleId: CIRCLE_ID }],
    ]),
    circles: new Set([CIRCLE_ID]),
    writes: new Map(),
    downloads: 0,
  };
}
reset();

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;
const throttle = { registerProviderKey: jest.fn() };
const jobScope = { run: async (_job: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) };

/** The subject lookups every handler starts with. */
function subjectLookups() {
  return {
    mediaItem: {
      findUnique: async ({ where }: { where: { id: string } }) => world.mediaItems.get(where.id) ?? null,
    },
    circle: {
      findUnique: async ({ where }: { where: { id: string } }) => (world.circles.has(where.id) ? { id: where.id } : null),
    },
  };
}

/** A service double whose every call records an idempotent write keyed by the media item. */
function recordingService(method: string) {
  return {
    [method]: async (context: { mediaItemId: string }) => {
      world.writes.set(`${method}:${context.mediaItemId}`, 'done');
    },
  };
}

const snapshot = () => ({ writes: [...world.writes.entries()].sort(), downloads: world.downloads });

// ---------------------------------------------------------------------------
// face_detection (node-eligible)
// ---------------------------------------------------------------------------

const buildFaceDetection = () =>
  new FaceDetectionHandler(
    registry,
    throttle as never,
    subjectLookups() as never,
    { ...recordingService('processMediaItem'), ...recordingService('persistFaces') } as never,
  );

describe('face_detection', () => {
  staticContract('face_detection', buildFaceDetection);
  describeJobHandlerConformance('face_detection', buildFaceDetection, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a photo',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a media item deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      { name: 'a job about no media item', expectFailure: 'not about a media item' },
    ],
  });
});

// ---------------------------------------------------------------------------
// video_face_detection (node-eligible): the real service, so the two skips are
// proven to happen before any download
// ---------------------------------------------------------------------------

let videoRow: Record<string, unknown>;

function buildVideoFaceDetection(): VideoFaceDetectionHandler {
  const prisma = {
    ...subjectLookups(),
    mediaItem: {
      findUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) => {
        const exists = world.mediaItems.get(args.where.id);
        if (!exists) return null;
        // The subject lookup selects { id, circleId }; the service's own read selects more.
        return 'socialMediaSource' in args.select ? { ...exists, ...videoRow } : exists;
      },
    },
    systemSettings: { findUnique: async () => ({ key: 'global', value: { face: { video: { enabled: true } } } }) },
  };
  const core = {
    markProcessing: async () => undefined,
    resolveProviderAndCreds: async () => ({ providerKey: 'compreface', modelVersion: 'v1', provider: {}, creds: {} }),
    markStatus: async (mediaItemId: string, status: string) => {
      world.writes.set(`faceStatus:${mediaItemId}`, status);
    },
    markFailed: async () => undefined,
  };
  const resolver = {
    getProviderFor: async () => ({
      download: async () => {
        world.downloads += 1;
        return Readable.from(Buffer.from('video'));
      },
    }),
  };
  const service = new VideoFaceDetectionService(
    prisma as never,
    core as never,
    {} as never,
    {} as never,
    resolver as never,
    { recordModel: async () => undefined } as never,
    { touchMediaItems: async () => undefined } as never,
    { get: async () => CIRCLE_ID } as never,
  );
  return new VideoFaceDetectionHandler(registry, prisma as never, service);
}

const VIDEO_STORAGE_OBJECT = {
  storageKey: 'uploads/clip.mp4',
  storageProvider: 's3',
  bucket: 'bucket',
  name: 'clip.mp4',
  size: BigInt(50_000_000),
};

describe('video_face_detection', () => {
  const savedCap = process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
  afterAll(() => {
    if (savedCap === undefined) delete process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
    else process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = savedCap;
  });

  staticContract('video_face_detection', buildVideoFaceDetection);
  describeJobHandlerConformance('video_face_detection', buildVideoFaceDetection, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a social-media-flagged video (skipped, no download)',
        subjectType: 'media_item',
        subjectId: VIDEO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: () => {
          reset();
          delete process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
          videoRow = { type: 'video', durationMs: 30_000, socialMediaSource: 'tiktok', storageObject: VIDEO_STORAGE_OBJECT };
        },
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { downloads: number }).downloads).toEqual(0);
          check((afterFirst as { writes: unknown }).writes).toEqual([[`faceStatus:${VIDEO_ID}`, 'no_faces']]);
        },
      },
      {
        name: 'a video over VIDEO_ENRICHMENT_MAX_BYTES (skipped, no download)',
        subjectType: 'media_item',
        subjectId: VIDEO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: () => {
          reset();
          process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = '1000';
          videoRow = { type: 'video', durationMs: 30_000, socialMediaSource: null, storageObject: VIDEO_STORAGE_OBJECT };
        },
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { downloads: number }).downloads).toEqual(0);
          check((afterFirst as { writes: unknown }).writes).toEqual([[`faceStatus:${VIDEO_ID}`, 'no_faces']]);
        },
      },
      {
        name: 'a video deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// face_auto_archive_sweep (server-only, per circle)
// ---------------------------------------------------------------------------

const ARCHIVED = { id: 'face-archived', embedding: [1, 0] };
let liveFaces: Array<{ id: string; embedding: number[]; mediaItemId: string; hiddenAt: Date | null }>;

function buildAutoArchiveSweep(): FaceAutoArchiveSweepHandler {
  const prisma = {
    ...subjectLookups(),
    face: {
      findMany: async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
        if (args.where['hiddenAt'] !== null && args.where['hiddenAt'] !== undefined) return [ARCHIVED];
        if ('mediaItemId' in args.select) {
          const ids = (args.where['id'] as { in: string[] }).in;
          return liveFaces.filter((f) => ids.includes(f.id)).map((f) => ({ mediaItemId: f.mediaItemId }));
        }
        return liveFaces.filter((f) => f.hiddenAt === null).map((f) => ({ id: f.id, embedding: f.embedding }));
      },
      updateMany: async (args: { where: { id: { in: string[] } } }) => {
        let count = 0;
        for (const face of liveFaces) {
          if (args.where.id.in.includes(face.id) && face.hiddenAt === null) {
            face.hiddenAt = new Date(0);
            world.writes.set(`hidden:${face.id}`, true);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  const matching = {
    archiveMaxCandidates: 100,
    findLiveMatchesAgainstArchived: async (_circleId: string, input: { liveBatch: Array<{ id: string; embedding: number[] }> }) =>
      input.liveBatch.filter((f) => f.embedding[0] === 1).map((f) => f.id),
  };
  const settings = { getSettings: async () => ({ features: { faceAutoArchive: true }, face: { autoArchive: { matchThreshold: 0.45 } } }) };
  return new FaceAutoArchiveSweepHandler(
    registry,
    prisma as never,
    matching as never,
    settings as never,
    { touchMediaItems: async () => undefined } as never,
  );
}

describe('face_auto_archive_sweep', () => {
  staticContract('face_auto_archive_sweep', buildAutoArchiveSweep);
  describeJobHandlerConformance('face_auto_archive_sweep', buildAutoArchiveSweep, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a circle with a live face matching an archived one',
        subjectType: 'circle',
        subjectId: CIRCLE_ID,
        arrange: () => {
          reset();
          liveFaces = [
            { id: 'face-match', embedding: [1, 0], mediaItemId: PHOTO_ID, hiddenAt: null },
            { id: 'face-other', embedding: [0, 1], mediaItemId: PHOTO_ID, hiddenAt: null },
          ];
        },
        observe: snapshot,
      },
      {
        name: 'a circle deleted since it was queued (no-op)',
        subjectType: 'circle',
        subjectId: GONE_ID,
        arrange: () => {
          reset();
          liveFaces = [];
        },
        observe: snapshot,
      },
      { name: 'a job about no circle', expectFailure: 'not about a circle' },
    ],
  });

  it('is server-only: no node pair', () => {
    const handler = buildAutoArchiveSweep() as unknown as JobHandler;
    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// metadata_extraction (node-eligible)
// ---------------------------------------------------------------------------

const buildMetadataExtraction = () =>
  new MetadataExtractionHandler(
    registry,
    jobScope as never,
    subjectLookups() as never,
    { ...recordingService('processMediaItem'), ...recordingService('persistMetadata') } as never,
  );

describe('metadata_extraction', () => {
  staticContract('metadata_extraction', buildMetadataExtraction);
  describeJobHandlerConformance('metadata_extraction', buildMetadataExtraction, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a photo',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a media item deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        arrange: reset,
        observe: snapshot,
      },
      { name: 'a job about no media item', expectFailure: 'not about a media item' },
    ],
  });
});

// ---------------------------------------------------------------------------
// thumbnail_regen (node-eligible, deriveOutputKey)
// ---------------------------------------------------------------------------

function buildThumbnailRegen(): ThumbnailRegenHandler {
  const prisma = {
    ...subjectLookups(),
    mediaItem: {
      findUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) => {
        const exists = world.mediaItems.get(args.where.id);
        if (!exists) return null;
        if ('storageObjectId' in args.select) return { storageObjectId: OBJECT_ID };
        if ('storageObject' in args.select) return { id: exists.id, deletedAt: null, storageObject: { id: OBJECT_ID } };
        return exists;
      },
    },
  };
  const recovery = {
    reprocessObjectNow: async (object: { id: string }) => {
      world.writes.set(`reprocessed:${object.id}`, true);
    },
  };
  return new ThumbnailRegenHandler(
    registry,
    jobScope as never,
    prisma as never,
    recovery as never,
    { persistThumbnail: async () => undefined } as never,
  );
}

describe('thumbnail_regen', () => {
  staticContract('thumbnail_regen', buildThumbnailRegen);
  describeJobHandlerConformance('thumbnail_regen', buildThumbnailRegen, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a photo',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a media item deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        arrange: reset,
        observe: snapshot,
      },
    ],
  });

  it('derives the node output key in the thumbnail namespace, the same for every request of one job', async () => {
    reset();
    const handler = buildThumbnailRegen();
    const job = mediaItemJob('thumbnail_regen', PHOTO_ID, CIRCLE_ID);
    const key = await handler.deriveOutputKey(job);
    expect(key).toMatch(new RegExp(`^thumbnails/${OBJECT_ID}-[0-9a-f]{16}\\.jpg$`));
    await expect(handler.deriveOutputKey(job)).resolves.toBe(key);
  });
});

// ---------------------------------------------------------------------------
// thumbnail_repair (server-only, global sweep)
// ---------------------------------------------------------------------------

function buildThumbnailRepair(): ThumbnailRepairHandler {
  const prisma = { $queryRaw: async () => [] };
  const system = { asSystem: () => prisma, runAsSystem: (_r: string, fn: (tx: unknown) => unknown) => fn(prisma) };
  return new ThumbnailRepairHandler(registry, prisma as never, system as never, {} as never, {} as never);
}

describe('thumbnail_repair', () => {
  staticContract('thumbnail_repair', buildThumbnailRepair);
  describeJobHandlerConformance('thumbnail_repair', buildThumbnailRepair, {
    testApi: legacyTypeTestApi,
    payloads: [{ name: 'a sweep with nothing to repair', arrange: reset, observe: snapshot }],
  });
});

// ---------------------------------------------------------------------------
// Eligibility as the platform derives it, and the node results
// ---------------------------------------------------------------------------

describe('node eligibility (derived by the platform registry)', () => {
  it('lists face_auto_archive_sweep and thumbnail_repair as server-only, not the other four', () => {
    const platform = new JobHandlerRegistry();
    for (const handler of [
      buildFaceDetection(),
      buildVideoFaceDetection(),
      buildAutoArchiveSweep(),
      buildMetadataExtraction(),
      buildThumbnailRegen(),
      buildThumbnailRepair(),
    ]) {
      platform.register(handler);
    }
    expect(platform.serverOnlyTypes().sort()).toEqual(['face_auto_archive_sweep', 'thumbnail_repair']);
  });
});

describe('node results', () => {
  const cases: Array<{ type: string; build: () => JobHandler; subject: string; valid: unknown; invalid: unknown }> = [
    {
      type: 'face_detection',
      build: buildFaceDetection,
      subject: PHOTO_ID,
      valid: {
        modelVersion: 'v1',
        providerKey: 'compreface',
        imageWidth: 800,
        imageHeight: 600,
        faces: [{ boundingBox: { x: 1, y: 2, width: 30, height: 40 }, confidence: 0.9, embedding: [0.1, 0.2] }],
      },
      invalid: { faces: [{ boundingBox: { x: 1 } }] },
    },
    {
      type: 'video_face_detection',
      build: buildVideoFaceDetection,
      subject: VIDEO_ID,
      valid: { modelVersion: 'v1', providerKey: 'compreface', clusters: [] },
      invalid: { clusters: 'none' },
    },
    {
      type: 'metadata_extraction',
      build: buildMetadataExtraction,
      subject: PHOTO_ID,
      valid: { exif: { width: 10, height: 20 }, probe: null },
      invalid: { exif: 'nope' },
    },
    {
      type: 'thumbnail_regen',
      build: buildThumbnailRegen,
      subject: PHOTO_ID,
      valid: { storageKey: `thumbnails/${OBJECT_ID}-0123456789abcdef.jpg`, width: 400, height: 300, bytes: 12_345 },
      invalid: { storageKey: '', width: 400, height: 300, bytes: 12_345 },
    },
  ];

  for (const c of cases) {
    it(`${c.type}: nodeResultSchema accepts a valid result and refuses an invalid one`, () => {
      const handler = c.build();
      expect(handler.nodeResultSchema!.safeParse(c.valid).success).toBe(true);
      expect(handler.nodeResultSchema!.safeParse(c.invalid).success).toBe(false);
    });

    it(`${c.type}: persistNodeResult refuses an invalid result by throwing`, async () => {
      reset();
      const handler = c.build();
      await expect(handler.persistNodeResult!(mediaItemJob(c.type, c.subject, CIRCLE_ID), c.invalid)).rejects.toThrow();
    });
  }
});
