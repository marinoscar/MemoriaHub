// =============================================================================
// The dedup/burst/social job handlers against the platform handler contract
// (RETRO-C5, #594)
// =============================================================================
//
// `describeJobHandlerConformance` (`@marinoscar/platform-api/jobs/testing`) holds
// each handler to the contract every job type shares: a label, a two-number
// profile, node eligibility derived from the schema/persist pair, a settle
// through the queue, an idempotent second run, failure by throwing and the dedup
// rule. The five types here are `duplicate_detection`,
// `duplicate_detection_batch`, `duplicate_confidence_backfill`,
// `burst_detection` and `social_media_detection`.
//
// ONE RULE IS WAIVED, ON PURPOSE (the RETRO-C3 approach, seam request EAB #1120).
// The kit's static case also requires a DOTTED type. MemoriaHub's type strings
// are permanent (`job-type-snapshot.spec.ts`), so the static case is replaced
// here by the same check with exactly that one violation filtered out.
//
// Beyond the contract, the scenarios the issue asks for: a photo subject, a gone
// subject (no-op), node results validated by `nodeResultSchema`, the social gate
// (DETECTED never fans out; CLEAN fans out the withheld video job exactly once,
// asserted on the kit's FakeJobQueue) and a landscape video classified on Tier 1
// alone, without a download or OCR. The burst-wins ordering is proven on a real
// database in `burst-wins.db.spec.ts`.
// =============================================================================

import { JobReason, MediaType } from '@prisma/client';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import {
  createFakeJobQueue,
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
  type FakeJobQueue,
} from '@marinoscar/platform-api/jobs/testing';
import type { ConformanceTestApi } from '@marinoscar/platform-api/testing';

import { BurstDetectionHandler } from '@marinoscar/memoriahub-api/burst';
import { DuplicateConfidenceBackfillHandler } from '@marinoscar/memoriahub-api/dedup';
import { DuplicateDetectionBatchHandler } from '@marinoscar/memoriahub-api/dedup';
import { DuplicateDetectionHandler } from '@marinoscar/memoriahub-api/dedup';
import { SocialMediaDetectionHandler, SocialMediaDetectorService } from '@marinoscar/memoriahub-api/social-media';
import { mediaItemJob } from '../helpers/platform-job';

const PHOTO_ID = '00000000-0000-4000-8000-00000000c501';
const VIDEO_ID = '00000000-0000-4000-8000-00000000c502';
const GONE_ID = '00000000-0000-4000-8000-00000000c5ff';
const CIRCLE_ID = '00000000-0000-4000-8000-00000000c5c1';
const GONE_CIRCLE_ID = '00000000-0000-4000-8000-00000000c5cf';

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
    const violations = findJobHandlerContractViolations(build()).filter(
      (v) => !v.includes('the type must be dotted'),
    );
    expect(violations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// One stateful fake world per test (`reset` in each scenario).
// ---------------------------------------------------------------------------

interface World {
  mediaItems: Map<string, { id: string; circleId: string }>;
  circles: Set<string>;
  writes: Map<string, unknown>;
  downloads: number;
  ocrRuns: number;
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
    ocrRuns: 0,
  };
}
reset();

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

/** The subject lookups every handler starts with. */
function subjectLookups() {
  return {
    mediaItem: {
      findUnique: async ({ where }: { where: { id: string } }) => world.mediaItems.get(where.id) ?? null,
    },
  };
}

const snapshot = () => ({
  writes: [...world.writes.entries()].sort(),
  downloads: world.downloads,
  ocrRuns: world.ocrRuns,
});

/** A 512-d embedding, the shape a node submits. */
const EMBEDDING = Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0.04 : -0.04));

// ---------------------------------------------------------------------------
// duplicate_detection (node-eligible)
// ---------------------------------------------------------------------------

function dedupService() {
  return {
    processMediaItem: async (mediaItemId: string) => {
      world.writes.set(`dedup:${mediaItemId}`, 'grouped');
    },
    persistDuplicate: async (context: { mediaItemId: string }, result: { embedding: number[] | null }) => {
      world.writes.set(`dedup:${context.mediaItemId}`, `persisted:${result.embedding?.length ?? 0}`);
    },
  };
}

const buildDuplicateDetection = () =>
  new DuplicateDetectionHandler(registry as never, subjectLookups() as never, dedupService() as never);

describe('duplicate_detection', () => {
  staticContract('duplicate_detection', buildDuplicateDetection);
  describeJobHandlerConformance('duplicate_detection', buildDuplicateDetection, {
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
        name: 'a photo deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { writes: unknown[] }).writes).toEqual([]);
        },
      },
      { name: 'a job about no media item', expectFailure: 'not about a media item' },
    ],
  });

  it('is node-eligible: the pair is present and the 512-d node result persists without a recompute', async () => {
    reset();
    const handler = buildDuplicateDetection();
    const queue = createFakeJobQueue();
    queue.register(handler);
    expect(queue.registry.serverOnlyTypes()).not.toContain('duplicate_detection');

    const job = mediaItemJob('duplicate_detection', PHOTO_ID, CIRCLE_ID);
    const valid = { model: 'clip-vit-b32-q8', embedding: EMBEDDING, dHash: '12345678901234567890' };
    expect(handler.nodeResultSchema.safeParse(valid).success).toBe(true);
    await handler.persistNodeResult(job, valid);
    expect(world.writes.get(`dedup:${PHOTO_ID}`)).toBe('persisted:512');
  });

  it('rejects an invalid node result by schema, before any write', async () => {
    reset();
    const handler = buildDuplicateDetection();
    const invalid = { model: 'clip-vit-b32-q8', embedding: [0.1, 0.2], dHash: 'x' };
    expect(handler.nodeResultSchema.safeParse(invalid).success).toBe(false);
    await expect(handler.persistNodeResult(mediaItemJob('duplicate_detection', PHOTO_ID, CIRCLE_ID), invalid)).rejects.toThrow();
    expect(world.writes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// duplicate_detection_batch (server-only, circle subject, 100-id chunks)
// ---------------------------------------------------------------------------

const buildBatch = () =>
  new DuplicateDetectionBatchHandler(registry as never, { scopeExists: async (id: string) => world.circles.has(id) } as never, dedupService() as never);

describe('duplicate_detection_batch', () => {
  staticContract('duplicate_detection_batch', buildBatch);
  describeJobHandlerConformance('duplicate_detection_batch', buildBatch, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a backfill chunk of two photos',
        subjectType: 'circle',
        subjectId: CIRCLE_ID,
        reason: 'backfill',
        payload: { mediaItemIds: [PHOTO_ID, VIDEO_ID] },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a chunk for a circle deleted since it was queued (no-op)',
        subjectType: 'circle',
        subjectId: GONE_CIRCLE_ID,
        reason: 'backfill',
        payload: { mediaItemIds: [PHOTO_ID] },
        arrange: reset,
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { writes: unknown[] }).writes).toEqual([]);
        },
      },
    ],
  });

  it('is server-only (derived: no node pair)', () => {
    const queue = createFakeJobQueue();
    queue.register(buildBatch());
    expect(queue.registry.serverOnlyTypes()).toContain('duplicate_detection_batch');
  });
});

// ---------------------------------------------------------------------------
// duplicate_confidence_backfill (server-only, global keyset pass)
// ---------------------------------------------------------------------------

let groups: Map<string, number | null>;

function buildConfidenceBackfill(): DuplicateConfidenceBackfillHandler {
  const prisma = {
    duplicateGroup: {
      findMany: async (args: { where: { id?: { gt: string } }; take: number }) =>
        [...groups.entries()]
          .filter(([id, confidence]) => confidence === null && (!args.where.id || id > args.where.id.gt))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, args.take)
          .map(([id]) => ({ id })),
      update: async (args: { where: { id: string }; data: { confidence: number } }) => {
        groups.set(args.where.id, args.data.confidence);
        world.writes.set(`confidence:${args.where.id}`, args.data.confidence);
      },
    },
    mediaItem: { findMany: async () => [{ id: 'm1' }, { id: 'm2' }] },
  };
  const detection = { computeGroupConfidence: async () => 0.97 };
  return new DuplicateConfidenceBackfillHandler(registry as never, prisma as never, detection as never);
}

describe('duplicate_confidence_backfill', () => {
  staticContract('duplicate_confidence_backfill', buildConfidenceBackfill);
  describeJobHandlerConformance('duplicate_confidence_backfill', buildConfidenceBackfill, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'two pending groups without a confidence',
        reason: 'backfill',
        arrange: () => {
          reset();
          groups = new Map([
            ['g-1', null],
            ['g-2', null],
            ['g-3', 0.99],
          ]);
        },
        observe: snapshot,
      },
    ],
  });

  it('is server-only (derived: no node pair)', () => {
    const queue = createFakeJobQueue();
    queue.register(buildConfidenceBackfill());
    expect(queue.registry.serverOnlyTypes()).toContain('duplicate_confidence_backfill');
  });
});

// ---------------------------------------------------------------------------
// burst_detection (server-only)
// ---------------------------------------------------------------------------

const buildBurst = () =>
  new BurstDetectionHandler(registry as never, subjectLookups() as never, {
    processMediaItem: async (context: { mediaItemId: string }) => {
      world.writes.set(`burst:${context.mediaItemId}`, 'grouped');
    },
  } as never);

describe('burst_detection', () => {
  staticContract('burst_detection', buildBurst);
  describeJobHandlerConformance('burst_detection', buildBurst, {
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
        name: 'a photo deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { writes: unknown[] }).writes).toEqual([]);
        },
      },
      { name: 'a job about no media item', expectFailure: 'not about a media item' },
    ],
  });

  it('is server-only (derived: no node pair)', () => {
    const queue = createFakeJobQueue();
    queue.register(buildBurst());
    expect(queue.registry.serverOnlyTypes()).toContain('burst_detection');
  });
});

// ---------------------------------------------------------------------------
// social_media_detection (node-eligible): the real handler and the real
// Tier-1 rule catalog over a fake database; the withheld video job is enqueued
// on the kit's FakeJobQueue so its dedup rule is the platform's own.
// ---------------------------------------------------------------------------

let videoRow: Record<string, unknown>;
let ocrEnabled: boolean;
let fanOutQueue: FakeJobQueue;

/** A portrait (or landscape) video row with its persisted ffprobe block. */
function videoItem(opts: { filename: string; width: number; height: number; formatTags?: Record<string, string> }) {
  return {
    id: VIDEO_ID,
    circleId: CIRCLE_ID,
    type: MediaType.video,
    deletedAt: null,
    addedById: 'user-1',
    originalFilename: opts.filename,
    durationMs: 15_000,
    width: opts.width,
    height: opts.height,
    socialMediaSource: null,
    storageObject: {
      storageKey: 'uploads/clip.mp4',
      storageProvider: 's3',
      bucket: 'bucket',
      name: opts.filename,
      size: BigInt(5_000_000),
      metadata: {
        _processing: {
          'video-probe': {
            ...(opts.formatTags ? { formatTags: opts.formatTags, streamTags: [] } : {}),
            formatName: 'mov,mp4',
            durationMs: 15_000,
            width: opts.width,
            height: opts.height,
          },
        },
      },
    },
  };
}

function socialPrisma() {
  const tx = {
    tag: {
      upsert: async (args: { create: { name: string } }) => {
        world.writes.set(`tag:${args.create.name}`, true);
        return { id: `tag-${args.create.name}` };
      },
    },
    mediaTag: {
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    mediaSocialStatus: {
      upsert: async (args: { where: { mediaItemId: string }; update: Record<string, unknown> }) => {
        world.writes.set(`socialStatus:${args.where.mediaItemId}`, {
          status: args.update['status'],
          isSocialMedia: args.update['isSocialMedia'] ?? null,
        });
      },
    },
    mediaItem: {
      update: async (args: { where: { id: string }; data: { socialMediaSource: string | null } }) => {
        world.writes.set(`source:${args.where.id}`, args.data.socialMediaSource);
      },
    },
  };
  return {
    ...subjectLookups(),
    ...tx,
    mediaItem: {
      ...tx.mediaItem,
      findUnique: async (args: { where: { id: string }; select: Record<string, unknown> }) => {
        const exists = world.mediaItems.get(args.where.id);
        if (!exists) return null;
        // The subject lookup selects { id, circleId }; the handler's own reads select more.
        return 'type' in args.select ? { ...exists, ...videoRow } : exists;
      },
    },
    // The handler's pre-processing status writes (processing / failed) are not
    // the outcome under test; record the last one like the transaction does.
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
}

function buildSocial(): SocialMediaDetectionHandler {
  const document: Record<string, unknown> = {
    features: { socialMediaDetection: true },
    socialMedia: { minConfidence: 0.8, ocrEnabled, maxDurationSeconds: 300, maxSizeBytes: 500_000_000 },
  };
  const settings = { readSystem: async (name: string) => ({ value: document[name], version: 1 }) };
  const ocr = {
    recognizeVideo: async () => {
      world.ocrRuns += 1;
      return { texts: [] };
    },
  };
  const resolver = {
    forLocation: async () => ({
      download: async () => {
        world.downloads += 1;
        throw new Error('no download expected in these scenarios');
      },
    }),
  };
  // The fan-out MediaEnrichmentService does: one video_face_detection job per
  // clean video, through the queue (whose dedup collapses a repeat).
  const mediaEnrichment = {
    enqueueVideoPostDetectionEnrichment: async (item: { id: string; circleId: string }, reason: JobReason) => {
      await fanOutQueue.enqueue({
        type: 'video_face_detection',
        reason,
        subjectType: 'media_item',
        subjectId: item.id,
        payload: { circleId: item.circleId },
        priority: reason === JobReason.rerun ? 0 : reason === JobReason.backfill ? 100 : 20,
      });
    },
  };
  return new SocialMediaDetectionHandler(
    { registerHandler: jest.fn() } as never,
    socialPrisma() as never,
    settings as never,
    new SocialMediaDetectorService(),
    ocr as never,
    resolver as never,
    mediaEnrichment as never,
  );
}

const fanOutJobs = () => fanOutQueue.jobs({ type: 'video_face_detection' }).length;

function arrangeSocial(row: Record<string, unknown>, ocr = false): () => void {
  return () => {
    reset();
    fanOutQueue = createFakeJobQueue();
    videoRow = row;
    ocrEnabled = ocr;
  };
}

const socialSnapshot = () => ({ ...snapshot(), fanOut: fanOutJobs() });

describe('social_media_detection', () => {
  const DETECTED = videoItem({ filename: 'tiktok_dance.mp4', width: 1080, height: 1920, formatTags: {} });
  const CLEAN = videoItem({ filename: 'birthday.mp4', width: 1080, height: 1920, formatTags: {} });
  const LANDSCAPE = videoItem({ filename: 'birthday.mp4', width: 1920, height: 1080 });

  staticContract('social_media_detection', buildSocial);
  describeJobHandlerConformance('social_media_detection', buildSocial, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a TikTok re-share (DETECTED: tagged, never fans out)',
        subjectType: 'media_item',
        subjectId: VIDEO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: arrangeSocial(DETECTED),
        observe: socialSnapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          const first = afterFirst as { fanOut: number; writes: Array<[string, unknown]> };
          check(first.fanOut).toEqual(0);
          check(Object.fromEntries(first.writes)[`source:${VIDEO_ID}`]).toEqual('tiktok');
        },
      },
      {
        name: 'a home video (CLEAN: fans out the withheld video job exactly once)',
        subjectType: 'media_item',
        subjectId: VIDEO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: arrangeSocial(CLEAN),
        observe: socialSnapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { fanOut: number }).fanOut).toEqual(1);
        },
      },
      {
        name: 'a landscape video (Tier 1 only: no download, no OCR)',
        subjectType: 'media_item',
        subjectId: VIDEO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: arrangeSocial(LANDSCAPE, true),
        observe: socialSnapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          const first = afterFirst as { downloads: number; ocrRuns: number; fanOut: number };
          check(first.downloads).toEqual(0);
          check(first.ocrRuns).toEqual(0);
          check(first.fanOut).toEqual(1);
        },
      },
      {
        name: 'a video deleted since it was queued (no-op)',
        subjectType: 'media_item',
        subjectId: GONE_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: arrangeSocial(CLEAN),
        observe: socialSnapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { writes: unknown[]; fanOut: number }).writes).toEqual([]);
          check((afterFirst as { fanOut: number }).fanOut).toEqual(0);
        },
      },
      { name: 'a job about no media item', expectFailure: 'not about a media item' },
    ],
  });

  describe('node results', () => {
    const job: Job = mediaItemJob('social_media_detection', VIDEO_ID, CIRCLE_ID, { reason: 'backfill' });
    const clean = { verdict: 'clean', score: 0, ocrText: null, platform: null, detectionMethod: null, matchedRule: null, confidence: 0 };
    const detected = { ...clean, verdict: 'detected', score: 0.9, platform: 'instagram', detectionMethod: 'ocr', matchedRule: 'ocr-instagram-word', confidence: 0.9 };

    it('is node-eligible (derived from the pair)', () => {
      const queue = createFakeJobQueue();
      queue.register(buildSocial());
      expect(queue.registry.serverOnlyTypes()).not.toContain('social_media_detection');
    });

    it('a CLEAN node verdict fans out once with the job reason, however often it is persisted', async () => {
      arrangeSocial(CLEAN)();
      const handler = buildSocial();
      await handler.persistNodeResult(job, clean);
      await handler.persistNodeResult(job, clean);
      const fanned = fanOutQueue.jobs({ type: 'video_face_detection' });
      expect(fanned).toHaveLength(1);
      expect(fanned[0]).toMatchObject({ subjectType: 'media_item', subjectId: VIDEO_ID, reason: 'backfill', priority: 100 });
    });

    it('a DETECTED node verdict tags the video and never fans out', async () => {
      arrangeSocial(CLEAN)();
      await buildSocial().persistNodeResult(job, detected);
      expect(fanOutJobs()).toBe(0);
      expect(world.writes.get(`source:${VIDEO_ID}`)).toBe('instagram');
    });

    it('an invalid node result is rejected by the schema, before any write', async () => {
      arrangeSocial(CLEAN)();
      const handler = buildSocial();
      const invalid = { verdict: 'maybe', score: 2 };
      expect(handler.nodeResultSchema.safeParse(invalid).success).toBe(false);
      await expect(handler.persistNodeResult(job, invalid)).rejects.toThrow();
      expect(world.writes.size).toBe(0);
      expect(fanOutJobs()).toBe(0);
    });
  });
});
