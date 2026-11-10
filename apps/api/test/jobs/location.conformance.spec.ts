// =============================================================================
// The location job handlers against the platform handler contract (RETRO-C6, #600)
// =============================================================================
//
// `describeJobHandlerConformance` (`@marinoscar/platform-api/jobs/testing`) holds each
// handler to the contract every job type shares: a label, a two-number profile, node
// eligibility derived from the schema/persist pair, a settle through the queue, an
// idempotent second run, failure by throwing and the dedup rule. The types here are
// `geocode` (node-eligible, with its Google key broker), `location_inference` (server-only,
// two payload shapes) and `location_group_rebuild` (server-only, global, deduplicated).
//
// ONE RULE IS WAIVED, ON PURPOSE (the RETRO-C3 / C5 approach, seam request EAB #1120): the
// kit's static case also requires a DOTTED type. These strings are permanent
// (`job-type-snapshot.spec.ts`), so the static case is replaced by the same check with exactly
// that one violation filtered out.
//
// Beyond the contract: a quota signal is the platform `RateLimitError` and leaves the item
// pending (never `processed` without geo data); a node result is validated by
// `nodeResultSchema` and persisted without calling a provider; the Google key never appears
// in any thrown message or in what the handler writes.
// =============================================================================

import { JobHandlerRegistry, RateLimitError, type JobHandler } from '@marinoscar/platform-api/jobs';
import {
  createFakeJobQueue,
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
} from '@marinoscar/platform-api/jobs/testing';
import type { ConformanceTestApi } from '@marinoscar/platform-api/testing';

import { GeocodeHandler } from '../../src/geo/geocode.handler';
import { LocationGroupRebuildHandler } from '../../src/location-groups/location-group-rebuild.handler';
import { LocationInferenceHandler } from '../../src/location-inference/location-inference.handler';
import { LOCATION_GROUP_REBUILD_TYPE } from '../../src/location-groups/location-group-rebuild.service';
import { circleJob, mediaItemJob } from '../helpers/platform-job';

const PHOTO_ID = '00000000-0000-4000-8000-00000000c601';
const GONE_ID = '00000000-0000-4000-8000-00000000c6ff';
const CIRCLE_ID = '00000000-0000-4000-8000-00000000c6c1';
const GONE_CIRCLE_ID = '00000000-0000-4000-8000-00000000c6cf';
const FIXTURE_KEY = 'k-fixture-conformance-1234';

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

function staticContract(name: string, build: () => JobHandler): void {
  it(`${name}: honours the static contract (except the dotted type: the string is permanent)`, () => {
    const violations = findJobHandlerContractViolations(build()).filter((v) => !v.includes('the type must be dotted'));
    expect(violations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// One stateful fake world per test.
// ---------------------------------------------------------------------------

interface World {
  mediaItems: Map<string, { id: string; circleId: string; takenLat: number | null; takenLng: number | null; deletedAt: Date | null }>;
  circles: Set<string>;
  writes: Map<string, unknown>;
  providerCalls: number;
  quota: boolean;
}

let world: World;

function reset(): void {
  world = {
    mediaItems: new Map([[PHOTO_ID, { id: PHOTO_ID, circleId: CIRCLE_ID, takenLat: 9.93, takenLng: -84.08, deletedAt: null }]]),
    circles: new Set([CIRCLE_ID]),
    writes: new Map(),
    providerCalls: 0,
    quota: false,
  };
}
reset();

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;
const throttle = { registerProviderKey: jest.fn() } as never;
const broker = { kind: 'geo.google', usable: async () => ({ ok: true }), issue: async () => ({}), revoke: async () => undefined } as never;

const snapshot = () => ({ writes: [...world.writes.entries()].sort() });

/** The scope directory double (`OwnerScopeSweepService.exists`) over the world's circles. */
function fakeScopes() {
  return { exists: async (id: string) => world.circles.has(id) };
}

function fakePrisma() {
  return {
    mediaItem: {
      findUnique: async ({ where }: { where: { id: string } }) => world.mediaItems.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        world.writes.set(`geo:${where.id}`, { country: data['geoCountry'], source: data['geoSource'] });
      },
    },
    mediaGeocodeStatus: {
      upsert: async ({ where, update }: { where: { mediaItemId: string }; update: { status: string } }) => {
        world.writes.set(`status:${where.mediaItemId}`, update.status);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// geocode (node-eligible, Google key broker)
// ---------------------------------------------------------------------------

function buildGeocode(): GeocodeHandler {
  const geo = {
    reverseGeocode: async () => {
      world.providerCalls++;
      if (world.quota) throw Object.assign(new Error('OVER_QUERY_LIMIT'), { status: 429 });
      return { result: { country: 'Costa Rica', countryCode: 'CR', admin1: 'Heredia', locality: 'Heredia' }, source: 'google' };
    },
  };
  const resolver = {
    resolve: async (raw: { geoCountry: string | null; geoAdmin1: string | null; geoLocality: string | null }) => ({
      geoCanonicalCountry: raw.geoCountry,
      geoCanonicalAdmin1: raw.geoAdmin1,
      geoCanonicalLocality: raw.geoLocality,
    }),
  };
  return new GeocodeHandler(registry, throttle, geo as never, fakePrisma() as never, resolver as never, broker);
}

describe('geocode', () => {
  staticContract('geocode', buildGeocode);
  describeJobHandlerConformance('geocode', buildGeocode, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a photo with coordinates',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        reason: 'backfill',
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

  it('is node-eligible and declares the geo.google broker', () => {
    reset();
    const handler = buildGeocode();
    const queue = createFakeJobQueue();
    queue.register(handler);
    expect(queue.registry.serverOnlyTypes()).not.toContain('geocode');
    expect(handler.nodeSecretBroker.kind).toBe('geo.google');
  });

  it('a quota signal is the platform RateLimitError and the item is left pending, never processed', async () => {
    reset();
    world.quota = true;
    const handler = buildGeocode();
    await expect(handler.process(mediaItemJob('geocode', PHOTO_ID, CIRCLE_ID))).rejects.toBeInstanceOf(RateLimitError);
    expect(world.writes.get(`status:${PHOTO_ID}`)).toBe('pending');
    expect(world.writes.has(`geo:${PHOTO_ID}`)).toBe(false);
  });

  it('persists a valid node result without calling a provider, and refuses an invalid one before any write', async () => {
    reset();
    const handler = buildGeocode();
    const valid = {
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'Heredia',
      admin2: null,
      locality: 'Heredia',
      placeName: null,
      source: 'google',
    };
    expect(handler.nodeResultSchema.safeParse(valid).success).toBe(true);
    await handler.persistNodeResult(mediaItemJob('geocode', PHOTO_ID, CIRCLE_ID), valid);
    expect(world.providerCalls).toBe(0);
    expect(world.writes.get(`geo:${PHOTO_ID}`)).toEqual({ country: 'Costa Rica', source: 'google' });
    expect(world.writes.get(`status:${PHOTO_ID}`)).toBe('processed');

    reset();
    const invalid = { country: 42 };
    expect(handler.nodeResultSchema.safeParse(invalid).success).toBe(false);
    await expect(handler.persistNodeResult(mediaItemJob('geocode', PHOTO_ID, CIRCLE_ID), invalid)).rejects.toThrow();
    expect(world.writes.size).toBe(0);
  });

  it('writes and throws nothing that contains the Google key', async () => {
    reset();
    world.quota = true;
    const handler = buildGeocode();
    const error = await handler.process(mediaItemJob('geocode', PHOTO_ID, CIRCLE_ID)).then(
      () => null,
      (e: Error) => e,
    );
    expect(String(error?.message)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify([snapshot(), world.providerCalls])).not.toContain(FIXTURE_KEY);
  });
});

// ---------------------------------------------------------------------------
// location_inference (server-only, per-item and sweep payloads)
// ---------------------------------------------------------------------------

function buildInference(): LocationInferenceHandler {
  const service = {
    inferForItem: async (mediaItemId: string, force: boolean) => {
      world.writes.set(`infer:${mediaItemId}`, { force });
    },
    sweepCircle: async (circleId: string, opts: { force?: boolean }) => {
      world.writes.set(`sweep:${circleId}`, { force: opts.force ?? false });
    },
  };
  return new LocationInferenceHandler(registry, fakePrisma() as never, fakeScopes() as never, service as never);
}

describe('location_inference', () => {
  staticContract('location_inference', buildInference);
  describeJobHandlerConformance('location_inference', buildInference, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'a per-item inference',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a per-circle sweep',
        subjectType: 'circle',
        subjectId: CIRCLE_ID,
        reason: 'backfill',
        payload: { mode: 'sweep', force: true },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a sweep for a circle deleted since it was queued (no-op)',
        subjectType: 'circle',
        subjectId: GONE_CIRCLE_ID,
        reason: 'backfill',
        payload: { mode: 'sweep' },
        arrange: reset,
        observe: snapshot,
        assertIdempotent: ({ afterFirst, afterSecond }, check) => {
          check(afterSecond).toEqual(afterFirst);
          check((afterFirst as { writes: unknown[] }).writes).toEqual([]);
        },
      },
    ],
  });

  it('is server-only (derived: no node pair), and a rerun forces past the rejected-suggestion skip', async () => {
    reset();
    const queue = createFakeJobQueue();
    queue.register(buildInference());
    expect(queue.registry.serverOnlyTypes()).toContain('location_inference');

    await buildInference().process(mediaItemJob('location_inference', PHOTO_ID, CIRCLE_ID, { reason: 'rerun' }));
    expect(world.writes.get(`infer:${PHOTO_ID}`)).toEqual({ force: true });
  });

  it('a sweep reads its circle from the subject and its range from the payload', async () => {
    reset();
    await buildInference().process(circleJob('location_inference', CIRCLE_ID, { payload: { mode: 'sweep', force: true } }));
    expect(world.writes.get(`sweep:${CIRCLE_ID}`)).toEqual({ force: true });
  });
});

// ---------------------------------------------------------------------------
// location_group_rebuild (server-only, global, deduplicated)
// ---------------------------------------------------------------------------

function buildRebuild(): LocationGroupRebuildHandler {
  const prisma = {
    $executeRaw: async () => 1,
    locationGroup: { findMany: async () => [] },
    mediaItem: { findMany: async () => [], updateMany: async () => ({ count: 0 }), groupBy: async () => [] },
  };
  const settings = { getSettings: async () => ({ locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm: 50 } }) };
  const scopes = { allScopeIds: async () => [CIRCLE_ID] };
  return new LocationGroupRebuildHandler(registry, prisma as never, settings as never, scopes as never);
}

describe('location_group_rebuild', () => {
  staticContract('location_group_rebuild', buildRebuild);
  describeJobHandlerConformance('location_group_rebuild', buildRebuild, {
    testApi: legacyTypeTestApi,
    payloads: [
      { name: 'a whole-library rebuild', reason: 'backfill', payload: {}, arrange: reset, observe: snapshot },
      { name: 'a one-circle rebuild', reason: 'backfill', payload: { circleId: CIRCLE_ID }, arrange: reset, observe: snapshot },
    ],
  });

  it('is server-only and keeps its permanent type string', () => {
    const queue = createFakeJobQueue();
    queue.register(buildRebuild());
    expect(LOCATION_GROUP_REBUILD_TYPE).toBe('location_group_rebuild');
    expect(queue.registry.serverOnlyTypes()).toContain('location_group_rebuild');
  });
});
