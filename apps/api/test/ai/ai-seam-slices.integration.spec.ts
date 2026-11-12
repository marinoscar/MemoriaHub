/**
 * The slices' AI calls through the real seam (RETRO-C4 #590, RETRO-J7 #618, RETRO-J8 #619; closes the #601 gap).
 *
 * The slices' unit specs script the `MEMORIAHUB_AI` port with jest doubles, which proves the request each call site
 * builds and nothing past it. Here the SAME call sites run over the web app's real binding
 * (`PlatformMemoriahubAiAdapter`) on the platform's REAL `AiService` (policy, key resolution, the kill switch, the
 * usage recorder) over a scripted fake provider, so what is asserted is what reaches the provider and what the
 * platform recorded:
 *
 *   - photo tagging is one image through feature `media_tagging`, video tagging several frames (and a transcript
 *     call through `video_transcription`) through `video_tagging`, both system calls (no acting user);
 *   - the agentic search streams `tool_call`, `token`, `results`, `done` (and `error` when the call is refused)
 *     as the user's own call under `search_agent`;
 *   - the picture enhancer's edit goes through `picture_enhance` as a system call with the OpenAI options;
 *   - memory titles are generated with NO actor (`forSystem`) and fall back (null) when the kill switch is on.
 */
jest.mock('sharp', () => {
  const pipeline = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue({ data: Buffer.from('prepared-frame'), info: { width: 800, height: 600 } }),
  };
  return jest.fn().mockReturnValue(pipeline);
});
jest.mock('@marinoscar/memoriahub-compute/image', () => ({
  ...jest.requireActual('@marinoscar/memoriahub-compute/image'),
  prepareImageForProcessing: jest.fn().mockResolvedValue({ buffer: Buffer.from('prepared-jpeg-bytes'), width: 800, height: 600 }),
}));
jest.mock('@marinoscar/memoriahub-compute/video', () => ({
  extractFrames: jest.fn(),
  extractAudioLead: jest.fn(),
}));

import { createAiRuntimeHarness, HARNESS_ORG_KEY, HARNESS_USER, HARNESS_USER_KEY, type AiRuntimeHarness } from '@marinoscar/platform-api/ai/testing';
import { extractAudioLead, extractFrames } from '@marinoscar/memoriahub-compute/video';
import { Readable } from 'node:stream';

import { PictureEnhancementHandler } from '@marinoscar/memoriahub-api/enhancement';
import { MemoryTitleService } from '@marinoscar/memoriahub-api/memories';
import { SearchAgentController, SearchAgentService } from '@marinoscar/memoriahub-api/search';
import { AutoTaggingService, VideoAutoTaggingService } from '@marinoscar/memoriahub-api/tagging';
import type { MemoriahubAiPort, MemoriahubSettingsPort } from '@marinoscar/memoriahub-api/ports';

import { MEMORIAHUB_AI_FEATURES as F } from '../../src/ai-port/ai-features';
import { PlatformMemoriahubAiAdapter } from '../../src/platform-memoriahub/ai/platform-memoriahub-ai.adapter';
import '../../src/app-registrations/ai';

const MODEL = 'fake-model';
const PROVIDER = 'openai';

/** The settings port the call sites read their saved model from (`ai.features.<key>`). */
function settingsWith(selections: Record<string, { provider: string; model: string } | null>): MemoriahubSettingsPort {
  return { readSystem: async () => ({ value: { features: selections }, version: 1 }) } as never;
}

describe('MemoriaHub AI call sites over the real AiService (RETRO #601)', () => {
  let harness: AiRuntimeHarness;
  let ai: MemoriahubAiPort;
  const orgId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    harness = createAiRuntimeHarness({
      orgKey: true,
      fake: {
        audioPort: true,
        imagesPort: true,
        responses: () => ({ outputText: '{"tags":["beach"],"description":"A beach at dusk."}' }),
      },
    });
    harness.setOrgKey(HARNESS_ORG_KEY);
    // The web app's binding: the same adapter the port resolves to in the booted host. The default organization
    // is the harness's, as the app's `DefaultOrgId` fallback resolves it for a system call.
    ai = new PlatformMemoriahubAiAdapter(withOrg(harness, orgId)) as never;
  });

  /** Replaces the fake provider's scripted answer (its internal script, as the app's AI fixture does). */
  function script(next: unknown): void {
    const fake = harness.fake as unknown as { script: unknown; scriptCursor: number };
    fake.script = next;
    fake.scriptCursor = 0;
  }

  /** `forSystem` without an `orgId` falls back to the harness organization: no change needed beyond the port. */
  function withOrg(h: AiRuntimeHarness, _org: string) {
    return h.ai;
  }

  describe('tagging: a photo is one image, a video several frames', () => {
    const photoCtx = { model: MODEL, system: 'SYSTEM', prompt: 'Tag this photo.', mimeType: 'image/jpeg', provider: PROVIDER, jobId: 'job-photo' };

    it('sends one image under media_tagging as a system call', async () => {
      const service = new AutoTaggingService({} as never, settingsWith({}), ai as never, {} as never, {} as never, {} as never);

      const result = await service.computeAutoTagging(Buffer.from('jpeg-bytes'), photoCtx);

      expect(result.rawText).toContain('beach');
      const [call] = harness.fake.calls.filter((c) => c.method === 'responses.create');
      const parts = (call!.request!.input as Array<{ content: Array<{ type: string }> }>)[0]!.content;
      expect(parts.map((p) => p.type)).toEqual(['text', 'image']);
      expect(call!.request!.instructions).toBe('SYSTEM');
      expect(harness.usageEvents).toEqual([
        expect.objectContaining({ feature: F.mediaTagging, userId: null, keySource: 'org' }),
      ]);
      expect(new Set(harness.fake.apiKeys)).toEqual(new Set([HARNESS_ORG_KEY]));
    });

    it('sends the ordered frames of a video in ONE call under video_tagging, with the transcript call under video_transcription', async () => {
      (extractFrames as jest.Mock).mockResolvedValue([
        { timestampMs: 1000, buffer: Buffer.from('f1') },
        { timestampMs: 5000, buffer: Buffer.from('f2') },
        { timestampMs: 9000, buffer: Buffer.from('f3') },
      ]);
      (extractAudioLead as jest.Mock).mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/mpeg' });
      const settings = settingsWith({ transcription: { provider: PROVIDER, model: 'fake-transcription-model' } });
      const service = new VideoAutoTaggingService({} as never, settings, ai as never, {} as never, {} as never, {} as never);

      const result = await service.computeVideoAutoTagging('/tmp/video.mp4', {
        durationMs: 12000,
        params: { maxFrames: 3, sampleIntervalSeconds: 5, transcriptionEnabled: true, leadSeconds: 30, streamInput: false },
        labelNames: ['beach'],
        peopleNames: [],
        model: MODEL,
        provider: PROVIDER,
        jobId: 'job-video',
      });

      expect(result.frameCount).toBe(3);
      expect(result.sampledTimestampsMs).toEqual([1000, 5000, 9000]);
      const visual = harness.fake.calls.filter((c) => c.method === 'responses.create');
      expect(visual).toHaveLength(1);
      const parts = (visual[0]!.request!.input as Array<{ content: Array<{ type: string }> }>)[0]!.content;
      expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'image', 'image']);
      expect(harness.fake.calls.filter((c) => c.method === 'audio.transcribe')).toHaveLength(1);
      expect(harness.usageEvents.map((e) => [e.feature, e.userId])).toEqual([
        [F.videoTranscription, null],
        [F.videoTagging, null],
      ]);
    });

    it('tags a video visual-only (one call, no transcription) when transcription is switched off', async () => {
      (extractFrames as jest.Mock).mockResolvedValue([{ timestampMs: 0, buffer: Buffer.from('f1') }]);
      const service = new VideoAutoTaggingService({} as never, settingsWith({}), ai as never, {} as never, {} as never, {} as never);

      await service.computeVideoAutoTagging('/tmp/video.mp4', {
        durationMs: 2000,
        params: { maxFrames: 1, sampleIntervalSeconds: 5, transcriptionEnabled: false, leadSeconds: 30, streamInput: false },
        labelNames: [],
        peopleNames: [],
        model: MODEL,
        provider: PROVIDER,
        jobId: 'job-video-2',
      });

      expect(harness.fake.calls.map((c) => c.method)).toEqual(['responses.create']);
      expect(harness.usageEvents.map((e) => e.feature)).toEqual([F.videoTagging]);
    });
  });

  describe('agentic search: the SSE events through the real AiService', () => {
    const frames = (raw: string): Array<{ event: string; data: Record<string, unknown> }> =>
      raw
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [event, data] = block.split('\n');
          return { event: event!.replace('event: ', ''), data: JSON.parse(data!.replace('data: ', '')) as Record<string, unknown> };
        });

    function controller(searchResult: unknown = { items: [{ id: 'm1' }], meta: { total: 1 } }) {
      const service = new SearchAgentService(
        settingsWith({ search: { provider: PROVIDER, model: MODEL } }),
        ai as never,
        { runSearch: jest.fn().mockResolvedValue(searchResult) } as never,
        { person: { findMany: jest.fn().mockResolvedValue([]) } } as never,
      );
      return new SearchAgentController(service, { requireOwnerRole: jest.fn().mockResolvedValue({ role: 'viewer' }) } as never);
    }

    async function run(c: SearchAgentController): Promise<string> {
      let out = '';
      await c.streamAgent(
        { circleId: '44444444-4444-4444-8444-444444444444', messages: [{ role: 'user', content: 'beach photos' }] } as never,
        { id: HARNESS_USER, roles: [], permissions: [], activeOrgId: null } as never,
        { raw: { writeHead: () => undefined, write: (chunk: string) => ((out += chunk), true), end: () => undefined } },
      );
      return out;
    }

    it('streams tool_call, results, token and done for a turn that searches then answers', async () => {
      let round = 0;
      script(() =>
        ++round === 1
          ? { output: [{ type: 'function_call', callId: 'c1', name: 'search_media', arguments: '{"semanticQuery":"beach"}' }] }
          : { outputText: 'Found 1 beach photo.' },
      );

      const events = frames(await run(controller()));

      const kinds = events.map((e) => e.event);
      // The provider streams the answer in chunks: the tool round first, then the text, then done.
      expect(kinds.slice(0, 2)).toEqual(['tool_call', 'results']);
      expect(kinds.slice(2, -1).every((k) => k === 'token')).toBe(true);
      expect(kinds[kinds.length - 1]).toBe('done');
      expect(events[0]!.data).toMatchObject({ name: 'search_media', args: { semanticQuery: 'beach' } });
      expect(events[1]!.data).toMatchObject({ items: [{ id: 'm1' }], meta: { total: 1 } });
      expect(events.filter((e) => e.event === 'token').map((e) => e.data['text']).join('')).toBe('Found 1 beach photo.');
      // The user's own call under the registered feature, carrying their key and never the deployment's.
      expect(harness.usageEvents.map((e) => [e.feature, e.userId])).toEqual([
        [F.searchAgent, HARNESS_USER],
        [F.searchAgent, HARNESS_USER],
      ]);
      expect(new Set(harness.fake.apiKeys)).toEqual(new Set([HARNESS_USER_KEY]));
    });

    it('streams an error event (and no done) when the call is refused before the provider is reached', async () => {
      harness.setPolicy({ enabled: false });

      const events = frames(await run(controller()));

      expect(events.map((e) => e.event)).toEqual(['error']);
      expect(JSON.stringify(events[0]!.data)).toMatch(/disabled|AI/i);
      expect(harness.fake.calls).toEqual([]);
      expect(harness.usageEvents).toEqual([]);
    });
  });

  describe('picture enhancement: one image edit as a system call', () => {
    function handlerOverTheSeam() {
      const update = jest.fn().mockResolvedValue({});
      const upload = jest.fn().mockResolvedValue({});
      const prisma = {
        mediaEnhancement: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'enh-1', mediaItemId: 'media-1', circleId: 'circle-1', status: 'pending', batchId: null, params: {},
            provider: PROVIDER, model: 'fake-image-model', prompt: 'Enhance this photograph.',
            originalWidth: 1200, originalHeight: 900, createdById: 'user-1',
          }),
          update,
        },
        mediaEnhancementBatch: { findUnique: jest.fn().mockResolvedValue(null) },
        mediaItem: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'media-1', type: 'photo', deletedAt: null, width: 1200, height: 900,
            storageObject: { storageKey: 'key-1', storageProvider: 's3', bucket: 'b', mimeType: 'image/jpeg' },
          }),
        },
      };
      const resolver = {
        forLocation: jest.fn().mockResolvedValue({ download: jest.fn().mockResolvedValue(Readable.from(Buffer.from('original'))) }),
        active: jest.fn().mockResolvedValue({ id: 'r2', store: { upload, getBucket: () => 'active-bucket' } }),
      };
      const tools = {
        renderThumbnail: async (bytes: Buffer) => bytes,
        readDimensions: async () => [1024, 768] as [number, number],
        carryOverMetadata: async (_original: Buffer, enhanced: Buffer) => enhanced,
      };
      const handler = new PictureEnhancementHandler(
        { registerHandler: jest.fn() } as never,
        prisma as never,
        resolver as never,
        ai as never,
        { readSystem: async () => ({ value: { defaultQuality: 'high', defaultStrength: 'balanced', stampExif: false }, version: 1 }) } as never,
        tools as never,
      );
      return { handler, update, upload };
    }

    const job = { id: 'job-enh', type: 'picture_enhancement', subjectType: 'media_item', subjectId: 'media-1', status: 'running', reason: 'rerun', payload: { enhancementId: 'enh-1', circleId: 'circle-1' }, attempts: 1, rateLimitHits: 0 } as never;

    it('edits through picture_enhance with no acting user, the OpenAI options and the organization key, and stages the result', async () => {
      const { handler, update, upload } = handlerOverTheSeam();

      await handler.process(job);

      const edits = harness.fake.calls.filter((c) => c.method === 'images.edit');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.imageRequest).toMatchObject({
        model: 'fake-image-model',
        quality: 'high',
        outputFormat: 'jpeg',
        providerOptions: { openai: { input_fidelity: 'high', output_compression: 90 } },
      });
      expect(harness.usageEvents).toEqual([expect.objectContaining({ feature: F.pictureEnhance, userId: null, keySource: 'org' })]);
      expect(new Set(harness.fake.apiKeys)).toEqual(new Set([HARNESS_ORG_KEY]));
      expect(upload).toHaveBeenCalled();
      expect(update.mock.calls.map((c) => c[0].data.status)).toEqual(expect.arrayContaining(['processing', 'ready']));
    });

    it('is refused by the kill switch before the provider is reached and never marks the enhancement ready', async () => {
      harness.setPolicy({ enabled: false });
      const { handler, update } = handlerOverTheSeam();

      await expect(handler.process(job)).rejects.toThrow();

      expect(harness.fake.calls).toEqual([]);
      expect(harness.usageEvents).toEqual([]);
      expect(update.mock.calls.some((c) => c[0].data.status === 'ready')).toBe(false);
    });
  });

  describe('memory titles: a system call with no actor', () => {
    const request = {
      type: 'on_this_day',
      templateTitle: 'On this day',
      templateSubtitle: null,
      meta: { yearsAgo: 3 },
      mediaItemIds: [],
      periodStart: new Date('2023-11-12T00:00:00Z'),
      periodEnd: new Date('2023-11-12T23:59:59Z'),
    } as never;
    const service = () => new MemoryTitleService({} as never, settingsWith({ memories: { provider: PROVIDER, model: MODEL } }), ai as never);

    it('generates through forSystem: the organization key pays, no user is recorded', async () => {
      script(() => ({
        outputText: '{"title":"Three years ago today","subtitle":"A day at the shore","narrative":"The shore, as it was."}',
      }));
      const svc = service();

      const title = await svc.generate(request, svc.beginRun({ backfill: false, aiTitlesEnabled: true }));

      expect(title).toEqual({ title: 'Three years ago today', subtitle: 'A day at the shore', narrative: 'The shore, as it was.', model: MODEL });
      // The usage row is written as the stream settles (the titler closes it as soon as it has the text).
      for (let i = 0; i < 40 && harness.usageEvents.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(harness.usageEvents).toEqual([expect.objectContaining({ feature: F.memoryTitles, userId: null, keySource: 'org' })]);
      expect(new Set(harness.fake.apiKeys)).toEqual(new Set([HARNESS_ORG_KEY]));
    });

    it('falls back to the template (null, never a throw) when the kill switch refuses the call', async () => {
      harness.setPolicy({ enabled: false });
      const svc = service();

      await expect(svc.generate(request, svc.beginRun({ backfill: false, aiTitlesEnabled: true }))).resolves.toBeNull();
      expect(harness.fake.calls).toEqual([]);
    });
  });
});
