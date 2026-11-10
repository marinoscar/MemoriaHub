// =============================================================================
// The four AI-bound job handlers against the platform handler contract
// (RETRO-C4, #590)
// =============================================================================
//
// `auto_tagging`, `video_auto_tagging`, `picture_enhancement` and
// `picture_enhancement_purge` are native, SERVER-ONLY platform `JobHandler`s
// (EAB AI rule 3: a provider key is resolved on the API and never brokered to a
// worker node). This file holds each to `describeJobHandlerConformance`, and
// pins the rule itself:
//
//   * `registry.serverOnlyTypes()` contains all four, and no handler of
//     `MEMORIAHUB_AI_JOB_TYPES` carries `nodeResultSchema` / `persistNodeResult`
//     (the guard that fails if anyone gives one back);
//   * the throttle gates the issue names (`tagging` shared by photo and video,
//     `enhance` for the image edit);
//   * the execution profiles.
//
// ONE RULE IS WAIVED, ON PURPOSE (the RETRO-C3/C5 approach, seam request EAB
// #1120): the kit's static case also requires a DOTTED type, and these strings are
// permanent (`job-type-snapshot.spec.ts`).
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { JobHandlerRegistry, ProviderThrottleService, type JobHandler } from '@marinoscar/platform-api/jobs';
import {
  describeJobHandlerConformance,
  findJobHandlerContractViolations,
} from '@marinoscar/platform-api/jobs/testing';
import type { ConformanceTestApi } from '@marinoscar/platform-api/testing';

import { MEMORIAHUB_AI_JOB_TYPES } from '../../src/app-registrations/jobs';
import { PictureEnhancementHandler } from '../../src/enhancement/picture-enhancement.handler';
import { PictureEnhancementPurgeHandler } from '../../src/enhancement/picture-enhancement-purge.handler';
import { AutoTaggingHandler, VideoAutoTaggingHandler } from '@marinoscar/memoriahub-api/tagging';

const PHOTO_ID = '00000000-0000-4000-8000-00000000c401';
const GONE_ID = '00000000-0000-4000-8000-00000000c4ff';
const CIRCLE_ID = '00000000-0000-4000-8000-00000000c4c1';

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
    const violations = findJobHandlerContractViolations(build()).filter(
      (v) => !v.includes('the type must be dotted'),
    );
    expect(violations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// One stateful fake world per test
// ---------------------------------------------------------------------------

interface World {
  mediaItems: Map<string, { id: string; circleId: string }>;
  writes: Map<string, string>;
}

let world: World;

function reset(): void {
  world = { mediaItems: new Map([[PHOTO_ID, { id: PHOTO_ID, circleId: CIRCLE_ID }]]), writes: new Map() };
}
reset();

const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;
const throttle = { registerProviderKey: jest.fn() } as unknown as ProviderThrottleService;

function subjectLookups() {
  return {
    mediaItem: {
      findUnique: async ({ where }: { where: { id: string } }) => world.mediaItems.get(where.id) ?? null,
    },
    circle: { findUnique: async () => null },
    // picture_enhancement: the row is gone (a no-op) unless a scenario stores one.
    mediaEnhancement: {
      findUnique: async () => null,
      findMany: async () => [],
      update: async () => ({}),
    },
  };
}

const snapshot = () => ({ writes: [...world.writes.entries()].sort() });

const taggingService = {
  processMediaItem: async (context: { mediaItemId: string }) => {
    world.writes.set(`tags:${context.mediaItemId}`, 'tagged');
  },
};

/**
 * The tagging handlers (RETRO-J7, #618) register through the jobs port, which the host adapts to the
 * platform registry and the throttle (`PlatformMemoriahubJobsAdapter.registerHandler`). This is that
 * adaptation reduced to what these specs read: the handler goes to the registry as it is, and the
 * throttle bucket it names is registered for its type.
 */
const jobsPortOver = (reg: JobHandlerRegistry, t: ProviderThrottleService) => ({
  registerHandler: (handler: JobHandler & { throttleKey?: string }) => {
    reg.register(handler);
    if (handler.throttleKey !== undefined) t.registerProviderKey(handler.type, handler.throttleKey);
  },
});

const buildAutoTagging = () =>
  new AutoTaggingHandler(
    jobsPortOver(registry, throttle) as never,
    subjectLookups() as never,
    taggingService as never,
  ) as unknown as JobHandler;
const buildVideoTagging = () =>
  new VideoAutoTaggingHandler(
    jobsPortOver(registry, throttle) as never,
    subjectLookups() as never,
    taggingService as never,
  ) as unknown as JobHandler;

function mediaItemScenarios() {
  return [
    {
      name: 'a media item',
      subjectType: 'media_item' as const,
      subjectId: PHOTO_ID,
      payload: { circleId: CIRCLE_ID },
      arrange: reset,
      observe: snapshot,
    },
    {
      name: 'a media item deleted since it was queued (no-op)',
      subjectType: 'media_item' as const,
      subjectId: GONE_ID,
      payload: { circleId: CIRCLE_ID },
      arrange: reset,
      observe: snapshot,
      assertIdempotent: (
        { afterFirst, afterSecond }: { afterFirst: unknown; afterSecond: unknown },
        check: (v: unknown) => { toEqual(e: unknown): void },
      ) => {
        check(afterSecond).toEqual(afterFirst);
        check((afterFirst as { writes: unknown[] }).writes).toEqual([]);
      },
    },
    { name: 'a job about no media item', expectFailure: 'not about a media item' },
  ];
}

for (const [type, build] of [
  ['auto_tagging', buildAutoTagging],
  ['video_auto_tagging', buildVideoTagging],
] as const) {
  describe(type, () => {
    staticContract(type, build);
    describeJobHandlerConformance(type, build, {
      testApi: legacyTypeTestApi,
      payloads: mediaItemScenarios() as never,
    });
  });
}

// ---------------------------------------------------------------------------
// picture_enhancement and its purge (no subject lookup: the row is in the payload)
// ---------------------------------------------------------------------------

const buildEnhancement = () =>
  new PictureEnhancementHandler(
    registry,
    throttle,
    subjectLookups() as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

describe('picture_enhancement', () => {
  staticContract('picture_enhancement', buildEnhancement);
  describeJobHandlerConformance('picture_enhancement', buildEnhancement, {
    testApi: legacyTypeTestApi,
    payloads: [
      {
        name: 'an enhancement row that no longer exists (no-op)',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { enhancementId: 'enh-gone', circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
      {
        name: 'a job without an enhancement id (no-op)',
        subjectType: 'media_item',
        subjectId: PHOTO_ID,
        payload: { circleId: CIRCLE_ID },
        arrange: reset,
        observe: snapshot,
      },
    ],
  });
});

const buildPurge = () =>
  new PictureEnhancementPurgeHandler(
    registry,
    subjectLookups() as never,
    {} as never,
    { getSettingValue: async () => 168 } as never,
  );

describe('picture_enhancement_purge', () => {
  staticContract('picture_enhancement_purge', buildPurge);
  describeJobHandlerConformance('picture_enhancement_purge', buildPurge, {
    testApi: legacyTypeTestApi,
    payloads: [{ name: 'nothing past the retention cutoff', arrange: reset, observe: snapshot }],
  });
});

// ---------------------------------------------------------------------------
// AI rule 3: server-only, permanently
// ---------------------------------------------------------------------------

describe('the AI-bound types are server-only (EAB AI rule 3)', () => {
  const handlers = [buildAutoTagging(), buildVideoTagging(), buildEnhancement(), buildPurge()] as unknown as JobHandler[];

  it('lists exactly the four permanent type strings', () => {
    expect([...MEMORIAHUB_AI_JOB_TYPES].sort()).toEqual(
      ['auto_tagging', 'picture_enhancement', 'picture_enhancement_purge', 'video_auto_tagging'],
    );
    expect(handlers.map((h) => h.type).sort()).toEqual([...MEMORIAHUB_AI_JOB_TYPES].sort());
  });

  it('JobHandlerRegistry.serverOnlyTypes() contains every one of them', () => {
    const real = new JobHandlerRegistry();
    for (const handler of handlers) real.register(handler);
    expect(real.serverOnlyTypes()).toEqual(expect.arrayContaining([...MEMORIAHUB_AI_JOB_TYPES]));
  });

  it('GUARD: no handler of MEMORIAHUB_AI_JOB_TYPES carries nodeResultSchema or persistNodeResult', () => {
    for (const handler of handlers) {
      expect({ type: handler.type, schema: handler.nodeResultSchema }).toEqual({
        type: handler.type,
        schema: undefined,
      });
      expect({ type: handler.type, persist: handler.persistNodeResult }).toEqual({
        type: handler.type,
        persist: undefined,
      });
    }
  });

  it('GUARD: a handler that regains a node pair is detected as node-eligible (the guard bites)', () => {
    const real = new JobHandlerRegistry();
    const regressed = Object.assign(buildAutoTagging(), {
      nodeResultSchema: { parse: (v: unknown) => v },
      persistNodeResult: async () => undefined,
    }) as unknown as JobHandler;
    real.register(regressed);
    expect(real.serverOnlyTypes()).not.toContain('auto_tagging');
  });

  it('declares the profiles of the issue', () => {
    const byType = Object.fromEntries(handlers.map((h) => [h.type, h.profile]));
    expect(byType).toEqual({
      auto_tagging: { maxRuntimeMs: 180_000, maxAttempts: 3 },
      video_auto_tagging: { maxRuntimeMs: 1_200_000, maxAttempts: 3 },
      picture_enhancement: { maxRuntimeMs: 600_000, maxAttempts: 3 },
      picture_enhancement_purge: { maxRuntimeMs: 600_000, maxAttempts: 2 },
    });
  });

  it('photo and video tagging share the `tagging` provider gate; the image edit has its own `enhance` gate', () => {
    const gate = new ProviderThrottleService(new ConfigService());
    const withGate = (build: (t: ProviderThrottleService) => { onModuleInit(): void }) => build(gate).onModuleInit();
    const reg = new JobHandlerRegistry();
    withGate(
      (t) => new AutoTaggingHandler(jobsPortOver(reg, t) as never, subjectLookups() as never, taggingService as never),
    );
    withGate(
      (t) =>
        new VideoAutoTaggingHandler(jobsPortOver(reg, t) as never, subjectLookups() as never, taggingService as never),
    );
    withGate(
      (t) =>
        new PictureEnhancementHandler(
          reg,
          t,
          subjectLookups() as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        ),
    );
    expect(gate.resolveKey('auto_tagging')).toBe('tagging');
    expect(gate.resolveKey('video_auto_tagging')).toBe('tagging');
    expect(gate.resolveKey('picture_enhancement')).toBe('enhance');
    expect(gate.resolveKey('picture_enhancement_purge')).toBeNull();
  });
});
