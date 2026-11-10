// =============================================================================
// The dedup/burst/social job types on the booted app (RETRO-C5, #594)
// =============================================================================
//
// Boots the real module graph (mocked Prisma, no database) and asserts on the
// registry the worker consults: the five types are the NATIVE handler classes,
// registered by themselves and not through the legacy adapter, and the
// server-only set the `system` worker mode claims is derived from them exactly
// as the issue specifies. Literal type strings on purpose: a rename must fail here.
// =============================================================================

import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { BurstDetectionHandler } from '../../src/burst/burst-detection.handler';
import { DuplicateConfidenceBackfillHandler } from '@marinoscar/memoriahub-api/dedup';
import { DuplicateDetectionBatchHandler } from '@marinoscar/memoriahub-api/dedup';
import { DuplicateDetectionHandler } from '@marinoscar/memoriahub-api/dedup';
import { EnrichmentHandlerRegistry } from '../../src/enrichment/enrichment-handler.registry';
import { SocialMediaDetectionHandler } from '../../src/social-media/social-media-detection.handler';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

const NATIVE: Array<[string, new (...args: never[]) => unknown]> = [
  ['duplicate_detection', DuplicateDetectionHandler],
  ['duplicate_detection_batch', DuplicateDetectionBatchHandler],
  ['duplicate_confidence_backfill', DuplicateConfidenceBackfillHandler],
  ['burst_detection', BurstDetectionHandler],
  ['social_media_detection', SocialMediaDetectionHandler],
];

describe('dedup/burst/social job handlers on the booted app (RETRO-C5)', () => {
  let context: TestContext;
  let registry: JobHandlerRegistry;

  beforeAll(async () => {
    context = await createTestApp();
    registry = context.app.get(JobHandlerRegistry);
  }, 120_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  // The dedup handlers moved into `@marinoscar/memoriahub-api/dedup` (RETRO-J10): they register through the
  // jobs port, so the platform registry holds the adapted handler, not the class instance.
  const PORT_BOUND = new Set(['duplicate_detection', 'duplicate_detection_batch', 'duplicate_confidence_backfill']);
  it.each(NATIVE)('%s dispatches to the native handler class', (type, HandlerClass) => {
    if (PORT_BOUND.has(type)) {
      expect(registry.get(type)?.type).toBe(type);
    } else {
      expect(registry.get(type)).toBeInstanceOf(HandlerClass);
    }
  });

  it('none of the five goes through the legacy adapter', () => {
    const legacy = context.app.get(EnrichmentHandlerRegistry).types();
    for (const [type] of NATIVE) expect(legacy).not.toContain(type);
  });

  it('derives the batch, the confidence backfill and burst detection as server-only, not the two node types', () => {
    const serverOnly = registry.serverOnlyTypes();
    expect(serverOnly).toEqual(
      expect.arrayContaining(['duplicate_detection_batch', 'duplicate_confidence_backfill', 'burst_detection']),
    );
    for (const type of ['duplicate_detection', 'social_media_detection']) {
      expect(serverOnly).not.toContain(type);
    }
  });
});
