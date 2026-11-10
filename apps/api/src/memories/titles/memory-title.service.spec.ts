/**
 * MemoryTitleService tests (epic #300, issue #306).
 *
 * NO NETWORK, EVER. The provider is a hand-written `AiProvider` double handed
 * back by a stubbed `AiProviderRegistry`, so nothing in this file can reach the
 * OpenAI or Anthropic SDKs at all — this is a level below the repo's
 * `jest.mock('openai')` convention and is strictly stronger, because a mocked
 * SDK still requires the production code to route through it.
 *
 * The acceptance criteria of #306 are almost entirely a list of failure modes
 * and the single behavior they must all share: fall back to the template,
 * without throwing and without failing the generation job. So the shape of this
 * file is one test per failure mode, each asserting the same two things —
 * `generate` resolved to `null`, and the run was not left in a state that would
 * corrupt the rest of the job.
 */

import { Logger } from '@nestjs/common';
import { MemoryType } from '@prisma/client';
import { AiError, type AiService, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import { MemoriaHubAiSettings } from '../../ai-port/memoriahub-ai-settings';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BACKFILL_AI_TITLE_CAP,
  MEMORY_TITLE_TEMPERATURE,
  MEMORY_TITLE_TIMEOUT_MS,
  MemoryTitleService,
} from './memory-title.service';
import { MemoryTitleRequest } from './memory-title.types';

const GOOD_RESPONSE =
  '{"title":"Five golden days","subtitle":"Tamarindo, March 2023","narrative":"Sunsets, surf and a first swim."}';

function request(over: Partial<MemoryTitleRequest> = {}): MemoryTitleRequest {
  return {
    type: MemoryType.trip,
    templateTitle: 'Trip to Guanacaste',
    templateSubtitle: 'March 2023',
    meta: { locality: 'Tamarindo', admin1: 'Guanacaste', country: 'Costa Rica' },
    mediaItemIds: ['item-1', 'item-2'],
    periodStart: new Date('2023-03-04T00:00:00.000Z'),
    periodEnd: new Date('2023-03-09T00:00:00.000Z'),
    ...over,
  };
}

/** Prisma double: the three bounded fact lookups, all trivially satisfiable. */
function fakePrisma(over: Record<string, unknown> = {}): PrismaService {
  return {
    mediaTag: { findMany: jest.fn().mockResolvedValue([{ tag: { name: 'beach' } }]) },
    mediaItem: { findMany: jest.fn().mockResolvedValue([{ description: 'A beach.' }]) },
    face: { findMany: jest.fn().mockResolvedValue([{ person: { name: 'Camila' } }]) },
    ...over,
  } as unknown as PrismaService;
}

// The scripted fakes below speak the old provider's chat vocabulary (`text`, `done`); the service
// now reads the platform's stream, so `build` maps one onto the other.
interface ChatRequest {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
}
type ChatStreamEvent = { type: 'text'; text: string } | { type: 'done' };
interface AiProvider {
  key: string;
  chat(creds: unknown, req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

/** A scripted chat source whose `chat` is driven by the supplied async generator body. */
function fakeProvider(
  chat: (req: ChatRequest) => AsyncIterable<ChatStreamEvent>,
): { provider: AiProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const provider = {
    key: 'openai',
    chat: (_creds: unknown, req: ChatRequest) => {
      requests.push(req);
      return chat(req);
    },
  } as unknown as AiProvider;
  return { provider, requests };
}

/** The common case: emit `text` once, then `done`. */
function textProvider(text: string) {
  // eslint-disable-next-line @typescript-eslint/require-await
  return fakeProvider(async function* () {
    yield { type: 'text', text } as ChatStreamEvent;
    yield { type: 'done' } as ChatStreamEvent;
  });
}

describe('MemoryTitleService', () => {
  let service: MemoryTitleService;
  let aiSettings: { selection: jest.Mock };
  let forSystem: jest.Mock;
  let prisma: PrismaService;
  let debug: jest.SpyInstance;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  function build(provider?: AiProvider): void {
    // The platform AiService as a system call: `stream` reads the scripted chat source.
    forSystem = jest.fn().mockReturnValue({
      stream: (req: any): AsyncIterable<AiStreamEvent> => ({
        // Delegates `next` and `return` to the scripted source, so closing the stream reaches it.
        [Symbol.asyncIterator]: () => {
          const inner = provider!
            .chat({}, {
              model: req.model,
              system: req.instructions,
              messages: [{ role: 'user', content: req.input }],
              temperature: req.temperature,
            })[Symbol.asyncIterator]();
          return {
            next: async () => {
              const step = await inner.next();
              if (step.done) return { done: true as const, value: undefined };
              const e = step.value;
              return {
                done: false as const,
                value: (e.type === 'text'
                  ? { type: 'output_text.delta', delta: e.text }
                  : { type: 'response.completed', response: { output: [] } }) as unknown as AiStreamEvent,
              };
            },
            return: async () => {
              await inner.return?.(undefined);
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    });
    service = new MemoryTitleService(
      prisma,
      aiSettings as unknown as MemoriaHubAiSettings,
      { forSystem } as unknown as AiService,
    );
  }

  beforeEach(() => {
    prisma = fakePrisma();
    aiSettings = {
      selection: jest.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-x' }),
    };
    // Degradation is the NORMAL path (#306) — it must never surface as an
    // error- or warn-level log, which is asserted in every fallback test below.
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    build(textProvider(GOOD_RESPONSE).provider);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Every fallback path shares this: nothing louder than debug is emitted. */
  function expectQuietDegradation(): void {
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  }

  // --- beginRun -------------------------------------------------------------

  describe('beginRun', () => {
    it('opens an uncapped budget for a scheduled run', () => {
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });
      expect(run).toEqual({
        enabled: true,
        backfill: false,
        maxAiCalls: Number.POSITIVE_INFINITY,
        aiCalls: 0,
        stopped: false,
        stopReason: null,
      });
    });

    it('caps a backfill run at BACKFILL_AI_TITLE_CAP calls', () => {
      expect(service.beginRun({ backfill: true, aiTitlesEnabled: true }).maxAiCalls).toBe(
        BACKFILL_AI_TITLE_CAP,
      );
    });

    // #315: a library backfill is sharded, and the cap is per JOB — so the
    // planner divides it across shards. beginRun accepts that slice.
    it('accepts a lower per-shard cap for a sharded backfill', () => {
      expect(
        service.beginRun({ backfill: true, aiTitlesEnabled: true, maxAiCalls: 5 }).maxAiCalls,
      ).toBe(5);
    });

    it('never lets a payload RAISE the backfill cap', () => {
      expect(
        service.beginRun({ backfill: true, aiTitlesEnabled: true, maxAiCalls: 10_000 })
          .maxAiCalls,
      ).toBe(BACKFILL_AI_TITLE_CAP);
    });

    it('ignores the override outside a backfill, where the budget is unbounded', () => {
      expect(
        service.beginRun({ backfill: false, aiTitlesEnabled: true, maxAiCalls: 5 }).maxAiCalls,
      ).toBe(Number.POSITIVE_INFINITY);
    });
  });

  // --- success --------------------------------------------------------------

  describe('the configured happy path', () => {
    it('returns the parsed title, subtitle, narrative and the model id', async () => {
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toEqual({
        title: 'Five golden days',
        subtitle: 'Tamarindo, March 2023',
        narrative: 'Sunsets, surf and a first swim.',
        // titleModel audit value — the whole point of the column.
        model: 'gpt-x',
      });
      expect(run.aiCalls).toBe(1);
      expect(run.stopped).toBe(false);
    });

    it('sends the system prompt, the fact block and a moderate temperature', async () => {
      const { provider, requests } = textProvider(GOOD_RESPONSE);
      build(provider);

      await service.generate(
        request(),
        service.beginRun({ backfill: false, aiTitlesEnabled: true }),
      );

      const sent = requests[0]!;
      expect(sent.model).toBe('gpt-x');
      expect(sent.temperature).toBe(MEMORY_TITLE_TEMPERATURE);
      expect(sent.system).toContain('family photo app');
      expect(sent.messages).toHaveLength(1);
      expect(sent.messages[0]!.role).toBe('user');
      expect(sent.messages[0]!.content).toContain('Place: Tamarindo, Guanacaste, Costa Rica');
      expect(sent.messages[0]!.content).toContain('Fallback title: Trip to Guanacaste');
      // METADATA ONLY: no image bytes, and no ids of any kind.
      expect(sent.messages[0]!.content).not.toContain('item-1');
    });

    it('reports an omitted subtitle/narrative as null rather than inventing one', async () => {
      // Substituting the TEMPLATE subtitle here would be the wrong layer: this
      // service reports what the model said, and MemoryCurationService.
      // titleColumns decides what to persist when a field came back empty.
      build(textProvider('{"title":"A quiet week"}').provider);

      await expect(
        service.generate(request(), service.beginRun({ backfill: false, aiTitlesEnabled: true })),
      ).resolves.toEqual({
        title: 'A quiet week',
        subtitle: null,
        narrative: null,
        model: 'gpt-x',
      });
    });

    it('names the memory subject first among the people it sends', async () => {
      const { provider, requests } = textProvider(GOOD_RESPONSE);
      build(provider);
      (prisma.face.findMany as jest.Mock).mockResolvedValue([
        { person: { name: 'Bystander' } },
        { person: { name: 'Abuela' } },
      ]);

      await service.generate(
        request({ type: MemoryType.person_highlights, meta: { personName: 'Abuela', year: 2025 } }),
        service.beginRun({ backfill: false, aiTitlesEnabled: true }),
      );

      expect(requests[0]!.messages[0]!.content).toContain('People pictured: Abuela, Bystander');
    });
  });

  // --- configuration gates: no provider call at all -------------------------

  describe('configuration gates (no provider call is made)', () => {
    it('memories.aiTitles.enabled = false → template, and the config is never read', async () => {
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: false });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      // The epic requires "off ⇒ templates only, and no provider call at all".
      expect(aiSettings.selection).not.toHaveBeenCalled();
      expect(forSystem).not.toHaveBeenCalled();
      expect(run.aiCalls).toBe(0);
    });

    it('ai.features.memories unset → template, and no platform call is made', async () => {
      aiSettings.selection.mockResolvedValue(null);
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(aiSettings.selection).toHaveBeenCalledWith('memories');
      expect(forSystem).not.toHaveBeenCalled();
      expect(run.aiCalls).toBe(0);
      expectQuietDegradation();
    });

    it('names the memory_titles feature and no acting user on the platform call', async () => {
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await service.generate(request(), run);

      expect(forSystem).toHaveBeenCalledWith({ orgId: null, feature: 'memory_titles' });
    });
  });

  // --- call-time failures ---------------------------------------------------

  describe('call-time failures', () => {
    it('a refused call (no key, model not enabled, kill switch) → template, quietly', async () => {
      build(
        fakeProvider(async function* () {
          throw new AiError('AI_KEY_REQUIRED', 'No API key is available for provider "openai".');
          // eslint-disable-next-line no-unreachable
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(run.stopped).toBe(false);
      expectQuietDegradation();
    });

    it('an HTTP/network error → template, and the run keeps going', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      build(
        fakeProvider(async function* () {
          throw Object.assign(new Error('Internal Server Error'), { status: 500 });
          // eslint-disable-next-line no-unreachable
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      // A 500 is not a throttle: the run must NOT stop titling everything else.
      expect(run.stopped).toBe(false);
      // The attempt still cost the provider work, so it consumes budget.
      expect(run.aiCalls).toBe(1);
      expectQuietDegradation();
    });

    it('a hung provider → template at the hard timeout, and the stream is closed', async () => {
      jest.useFakeTimers();
      const returned = jest.fn();
      const hung: AiProvider = {
        key: 'openai',
        chat: () => ({
          [Symbol.asyncIterator]: () => ({
            // Never resolves — the exact stall the timeout exists for.
            next: () => new Promise<IteratorResult<ChatStreamEvent>>(() => undefined),
            return: async () => {
              returned();
              return { done: true, value: undefined };
            },
          }),
        }),
      } as unknown as AiProvider;
      build(hung);
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      const pending = service.generate(request(), run);
      // Let the pre-call awaits (config, credentials, facts) settle first.
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(MEMORY_TITLE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBeNull();
      expect(returned).toHaveBeenCalled();
      expect(run.stopped).toBe(false);
      expect(run.aiCalls).toBe(1);
      jest.useRealTimers();
      expectQuietDegradation();
    });

    it('malformed (non-JSON) output → template', async () => {
      build(textProvider('I am sorry, I cannot title that.').provider);
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(run.aiCalls).toBe(1);
      expectQuietDegradation();
    });

    it('valid JSON with an empty title → template', async () => {
      build(textProvider('{"title":"","narrative":"lovely"}').provider);

      await expect(
        service.generate(request(), service.beginRun({ backfill: false, aiTitlesEnabled: true })),
      ).resolves.toBeNull();
      expectQuietDegradation();
    });

    it('an empty stream (no text at all) → template', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      build(
        fakeProvider(async function* () {
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );

      await expect(
        service.generate(request(), service.beginRun({ backfill: false, aiTitlesEnabled: true })),
      ).resolves.toBeNull();
      expectQuietDegradation();
    });

    it('a failing fact lookup → template, never a thrown error into the curator', async () => {
      (prisma.mediaTag.findMany as jest.Mock).mockRejectedValue(new Error('db exploded'));
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(run.aiCalls).toBe(0);
      expectQuietDegradation();
    });
  });

  // --- rate limiting --------------------------------------------------------

  describe('rate limiting stops the run without failing the job', () => {
    // The platform maps a provider 429 and Anthropic's 529 alike to AI_RATE_LIMITED.
    it.each([
      ['429', 30_000],
      ['529 (Anthropic overloaded)', undefined],
    ])('a %s stops AI titling for the remainder of the run', async (_label, retryAfterMs) => {
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/require-await
      build(
        fakeProvider(async function* () {
          calls += 1;
          throw new AiError('AI_RATE_LIMITED', 'Too Many Requests', { retryAfterMs });
          // eslint-disable-next-line no-unreachable
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(run.stopped).toBe(true);
      expect(run.stopReason).toBe('rate_limited');

      // Every subsequent memory in this run is templated WITHOUT another call —
      // #306 rejects routing this through the enrichment deferral path, because
      // deferring a whole generation job over a cosmetic field is worse.
      await expect(service.generate(request(), run)).resolves.toBeNull();
      await expect(service.generate(request(), run)).resolves.toBeNull();
      expect(calls).toBe(1);
      expect(run.aiCalls).toBe(1);
      expectQuietDegradation();
    });
  });

  // --- cost control ---------------------------------------------------------

  describe('backfill cost control', () => {
    it('makes at most BACKFILL_AI_TITLE_CAP calls per backfill job', async () => {
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/require-await
      build(
        fakeProvider(async function* () {
          calls += 1;
          yield { type: 'text', text: GOOD_RESPONSE } as ChatStreamEvent;
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );
      const run = service.beginRun({ backfill: true, aiTitlesEnabled: true });

      const results = [];
      for (let i = 0; i < BACKFILL_AI_TITLE_CAP + 5; i += 1) {
        results.push(await service.generate(request(), run));
      }

      expect(calls).toBe(BACKFILL_AI_TITLE_CAP);
      expect(results.slice(0, BACKFILL_AI_TITLE_CAP).every((r) => r !== null)).toBe(true);
      // Beyond the cap: templates, not failures.
      expect(results.slice(BACKFILL_AI_TITLE_CAP).every((r) => r === null)).toBe(true);
      expect(run.stopReason).toBe('budget_exhausted');
    });

    it('a scheduled (non-backfill) run is uncapped', async () => {
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/require-await
      build(
        fakeProvider(async function* () {
          calls += 1;
          yield { type: 'text', text: GOOD_RESPONSE } as ChatStreamEvent;
          yield { type: 'done' } as ChatStreamEvent;
        }).provider,
      );
      const run = service.beginRun({ backfill: false, aiTitlesEnabled: true });

      for (let i = 0; i < BACKFILL_AI_TITLE_CAP + 5; i += 1) {
        await service.generate(request(), run);
      }

      expect(calls).toBe(BACKFILL_AI_TITLE_CAP + 5);
      expect(run.stopped).toBe(false);
    });
  });
});
