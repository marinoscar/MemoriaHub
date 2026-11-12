/**
 * A provider throttle defers the AI jobs; it never fails them (RETRO-C4 #590; closes the retro-gaps audit).
 *
 * The platform queue defers a job on `instanceof RateLimitError` and on nothing else (no attempt consumed,
 * a backoff, the provider's `Retry-After` as a floor), and charges an attempt for any other throw. The
 * MemoriaHub side of that contract is the web edition's jobs adapter (`PlatformMemoriahubJobsAdapter.run`) over
 * the handlers' own classification. This spec runs the REAL handlers through the REAL adapter wrapper the queue
 * calls, with the model call going through the real `AiService` over a fake provider, and asserts which way each
 * failure goes:
 *
 *   - an AI rate limit (the provider's 429, the platform's AI_RATE_LIMITED) in a photo-tagging job: deferred,
 *     with the retry hint, and the `tagging` bucket registered for the type;
 *   - the same in a picture-enhancement job: deferred, and the enhancement row goes back to `pending` (never
 *     `failed`) while the queue still has budget;
 *   - a raw provider SDK status 429 or 529 (Anthropic "Overloaded") and an S3 `SlowDown` from the object
 *     store, in an enhancement job: deferred;
 *   - a non-throttle failure (an HTTP 500, an invalid key): NOT deferred, so the queue charges an attempt.
 */
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { AiError } from '@marinoscar/platform-api/ai';
import { createAiRuntimeHarness, HARNESS_ORG_KEY, type AiRuntimeHarness } from '@marinoscar/platform-api/ai/testing';
import { JobHandlerRegistry, ProviderThrottleService, RateLimitError, type Job } from '@marinoscar/platform-api/jobs';
import { PictureEnhancementHandler } from '@marinoscar/memoriahub-api/enhancement';
import type { MemoriahubSettingsPort } from '@marinoscar/memoriahub-api/ports';
import { AutoTaggingHandler, AutoTaggingService } from '@marinoscar/memoriahub-api/tagging';

import '../../src/app-registrations/ai';
import { PlatformMemoriahubAiAdapter } from '../../src/platform-memoriahub/ai/platform-memoriahub-ai.adapter';
import { PlatformMemoriahubJobsAdapter } from '../../src/platform-memoriahub/jobs/platform-memoriahub-jobs.adapter';

jest.mock('@marinoscar/memoriahub-compute/image', () => ({
  ...jest.requireActual('@marinoscar/memoriahub-compute/image'),
  prepareImageForProcessing: jest.fn().mockResolvedValue({ buffer: Buffer.from('prepared'), width: 800, height: 600 }),
}));

const PROVIDER = 'openai';
const settingsWith = (selections: Record<string, unknown>): MemoriahubSettingsPort =>
  ({ readSystem: async () => ({ value: { features: selections }, version: 1 }) }) as never;

describe('provider throttles defer the AI jobs and never fail them', () => {
  let harness: AiRuntimeHarness;
  let registry: JobHandlerRegistry;
  let throttle: ProviderThrottleService;
  let adapter: PlatformMemoriahubJobsAdapter;
  let ai: PlatformMemoriahubAiAdapter;

  beforeEach(() => {
    harness = createAiRuntimeHarness({ orgKey: true, fake: { imagesPort: true } });
    harness.setOrgKey(HARNESS_ORG_KEY);
    ai = new PlatformMemoriahubAiAdapter(harness.ai);
    registry = new JobHandlerRegistry();
    throttle = new ProviderThrottleService(new ConfigService());
    adapter = new PlatformMemoriahubJobsAdapter({} as never, registry, throttle, {} as never, {} as never, { on: jest.fn() } as never, {} as never);
  });

  const script = (next: unknown): void => {
    const fake = harness.fake as unknown as { script: unknown; scriptCursor: number };
    fake.script = next;
    fake.scriptCursor = 0;
  };

  /** What the queue calls for a claimed row. */
  const runThroughQueue = (type: string, job: Partial<Job>): Promise<void> =>
    registry.get(type)!.process({ id: 'job-1', type, attempts: 1, rateLimitHits: 0, providerKey: null, ...job } as Job);

  const classify = async (run: Promise<void>): Promise<{ deferred: boolean; retryAfterMs?: number }> => {
    const error = await run.then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    return error instanceof RateLimitError ? { deferred: true, retryAfterMs: error.retryAfterMs } : { deferred: false };
  };

  // ---- tagging ---------------------------------------------------------------------------------------------

  function taggingJob() {
    const real = new AutoTaggingService({} as never, settingsWith({}), ai as never, {} as never, {} as never, {} as never);
    // The job's model call is the real one (`computeAutoTagging`); everything before it (the gates, the image) is the host's data path.
    const service = {
      processMediaItem: async (context: { id: string }) =>
        void (await real.computeAutoTagging(Buffer.from('jpeg'), {
          model: 'fake-model', system: 's', prompt: 'p', mimeType: 'image/jpeg', provider: PROVIDER, jobId: context.id,
        })),
    };
    const subjects = { mediaItem: { findUnique: async () => ({ id: 'media-1', circleId: 'circle-1' }) } };
    adapter.registerHandler(new AutoTaggingHandler(adapter as never, subjects as never, service as never) as never);
    return { type: 'auto_tagging', job: { subjectType: 'media_item', subjectId: 'media-1', payload: { circleId: 'circle-1' } } as Partial<Job> };
  }

  it('defers a photo-tagging job on an AI rate limit, with the provider hint, on the shared `tagging` bucket', async () => {
    script(() => { throw new AiError('AI_RATE_LIMITED', 'Too many requests', { retryAfterMs: 7000 }); });
    const { type, job } = taggingJob();

    const bucket = jest.spyOn(throttle, 'registerProviderKey');

    const outcome = await classify(runThroughQueue(type, job));

    expect(outcome).toEqual({ deferred: true, retryAfterMs: 7000 });
    expect(bucket).toHaveBeenCalledWith('auto_tagging', 'tagging');
  });

  it('does not defer a photo-tagging job on a failure that is not a throttle (the queue charges an attempt)', async () => {
    script(() => { throw new AiError('AI_KEY_INVALID', 'The key was refused'); });
    const { type, job } = taggingJob();

    expect(await classify(runThroughQueue(type, job))).toEqual({ deferred: false });
  });

  // ---- picture enhancement ---------------------------------------------------------------------------------

  function enhancementJob(download: () => Promise<Readable>) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      mediaEnhancement: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'enh-1', mediaItemId: 'media-1', circleId: 'circle-1', status: 'pending', batchId: null, params: {},
          provider: PROVIDER, model: 'fake-image-model', prompt: 'Enhance.', originalWidth: 1200, originalHeight: 900, createdById: 'u',
        }),
        update,
      },
      mediaEnhancementBatch: { findUnique: jest.fn().mockResolvedValue(null) },
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'media-1', type: 'photo', deletedAt: null, width: 1200, height: 900,
          storageObject: { storageKey: 'k', storageProvider: 's3', bucket: 'b', mimeType: 'image/jpeg' },
        }),
      },
    };
    const resolver = {
      forLocation: jest.fn().mockResolvedValue({ download }),
      active: jest.fn().mockResolvedValue({ id: 's3', store: { upload: jest.fn(), getBucket: () => 'b' } }),
    };
    const tools = { renderThumbnail: async (b: Buffer) => b, readDimensions: async () => [10, 10] as [number, number], carryOverMetadata: async (_o: Buffer, e: Buffer) => e };
    adapter.registerHandler(
      new PictureEnhancementHandler(adapter as never, prisma as never, resolver as never, ai as never, { readSystem: async () => ({ value: {}, version: 1 }) } as never, tools as never) as never,
    );
    return { type: 'picture_enhancement', job: { subjectType: 'media_item', subjectId: 'media-1', payload: { enhancementId: 'enh-1', circleId: 'circle-1' } } as Partial<Job>, update };
  }

  const okDownload = async () => Readable.from(Buffer.from('original'));
  const failedStatuses = (update: jest.Mock) => update.mock.calls.map((c) => c[0].data.status);

  it('defers a picture-enhancement job on an AI rate limit and puts the enhancement back to pending, never failed', async () => {
    script([]);
    const { type, job, update } = enhancementJob(okDownload);
    // The image edit is the provider call that is throttled.
    jest.spyOn(harness.ai, 'forSystem').mockReturnValue({
      editImageInline: async () => { throw new AiError('AI_RATE_LIMITED', 'Too many requests'); },
    } as never);

    expect((await classify(runThroughQueue(type, job))).deferred).toBe(true);
    expect(failedStatuses(update)).not.toContain('failed');
    expect(failedStatuses(update)[failedStatuses(update).length - 1]).toBe('pending');
  });

  it.each([
    ['an HTTP 429', () => Object.assign(new Error('Too Many Requests'), { status: 429 })],
    ['an HTTP 529 (Anthropic overloaded)', () => Object.assign(new Error('Overloaded'), { status: 529 })],
    ['an S3 SlowDown', () => Object.assign(new Error('Please reduce your request rate.'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } })],
  ])('defers a picture-enhancement job on %s from the object store', async (_name, make) => {
    const { type, job, update } = enhancementJob(async () => { throw make(); });

    expect((await classify(runThroughQueue(type, job))).deferred).toBe(true);
    expect(failedStatuses(update)).not.toContain('failed');
  });

  it('does not defer a picture-enhancement job on an HTTP 500 from the object store (the queue charges an attempt)', async () => {
    const { type, job } = enhancementJob(async () => { throw Object.assign(new Error('Internal Server Error'), { status: 500 }); });

    expect(await classify(runThroughQueue(type, job))).toEqual({ deferred: false });
  });
});
