import { AiError } from '@marinoscar/platform-api/ai';
import { FakeAiProvider } from '@marinoscar/platform-api/ai/testing';

import { classifyRateLimit } from '../enrichment/rate-limit.error';
import {
  isCustomOpenAiEndpoint,
  isEligibleOpenAiModel,
  LegacyAnthropicProvider,
  LegacyOpenAiProvider,
  toInputItems,
  toLegacyProviderError,
  type LegacyAdapterSet,
} from './legacy-ai-provider.adapter';
import type { ChatStreamEvent } from './legacy-ai-provider.types';

// =============================================================================
// The legacy provider contract over the platform adapters (RETRO-E1, #595)
// =============================================================================
// Each provider is driven against `FakeAiProvider` (the platform's scripted
// adapter), so these tests prove the MAPPING: what MemoriaHub's call sites send
// reaches the platform request shape, and what comes back (including errors)
// reaches the call sites in the shape they always read.
// =============================================================================

const KEY = 'sk-test-placeholder-key';

function fakes(overrides: Partial<Record<keyof LegacyAdapterSet, FakeAiProvider>> = {}) {
  const set = {
    openai: overrides.openai ?? new FakeAiProvider({ id: 'openai', embeddingsPort: true }),
    openaiCompatible: overrides.openaiCompatible ?? new FakeAiProvider({ id: 'openai-compatible' }),
    anthropic: overrides.anthropic ?? new FakeAiProvider({ id: 'anthropic' }),
  };
  return set;
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('legacy AI providers over the platform adapters', () => {
  describe('chat', () => {
    it('maps the history, the system prompt and the tools, and streams text then done', async () => {
      const openai = new FakeAiProvider({ id: 'openai', responses: [{ outputText: 'Hello there' }] });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const events = await collect(
        provider.chat(
          { apiKey: KEY },
          {
            model: 'gpt-5.5',
            system: 'Be brief',
            temperature: 0.7,
            messages: [
              { role: 'user', content: 'find beach photos' },
              {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call_1', name: 'search_media', input: { tag: 'beach' } }],
              },
              { role: 'tool', content: '{"count":3}', toolCallId: 'call_1', toolName: 'search_media' },
            ],
            tools: [
              {
                name: 'search_media',
                description: 'Search',
                inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
              },
            ],
          },
        ),
      );

      const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
      expect(text).toBe('Hello there');
      expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'stop' });

      const call = openai.calls.find((c) => c.method === 'responses.stream');
      expect(call?.apiKey).toBe(KEY);
      expect(call?.request).toMatchObject({
        model: 'gpt-5.5',
        instructions: 'Be brief',
        temperature: 0.7,
        providerOptions: { openai: { parallel_tool_calls: false } },
      });
      expect(call?.request?.input).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'find beach photos' }] },
        { type: 'function_call', callId: 'call_1', name: 'search_media', arguments: '{"tag":"beach"}' },
        { type: 'function_call_output', callId: 'call_1', output: '{"count":3}' },
      ]);
      expect(call?.request?.tools?.[0]).toMatchObject({ type: 'function', name: 'search_media', strict: false });
    });

    it('emits a tool call the model makes, with its arguments parsed', async () => {
      const openai = new FakeAiProvider({
        id: 'openai',
        responses: [
          {
            outputText: '',
            finishReason: 'tool_calls',
            output: [{ type: 'function_call', callId: 'call_9', name: 'search_media', arguments: '{"tag":"dog"}' }],
          },
        ],
      });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const events = await collect(
        provider.chat({ apiKey: KEY }, { model: 'gpt-5.5', messages: [{ role: 'user', content: 'dogs' }] }),
      );

      expect(events).toContainEqual({ type: 'tool_call', id: 'call_9', name: 'search_media', input: { tag: 'dog' } });
      expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
      expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'tool_calls' });
    });

    it('gives Anthropic the 16000-token budget and the default model', async () => {
      const anthropic = new FakeAiProvider({ id: 'anthropic', responses: [{ outputText: 'ok' }] });
      const provider = new LegacyAnthropicProvider(fakes({ anthropic }));

      await collect(provider.chat({ apiKey: KEY }, { model: '', messages: [{ role: 'user', content: 'hi' }] }));

      const call = anthropic.calls.find((c) => c.method === 'responses.stream');
      expect(call?.request).toMatchObject({ model: 'claude-opus-4-8', maxOutputTokens: 16000 });
    });
  });

  describe('analyzeImage', () => {
    it('sends OpenAI the prompt first, then every frame in order, with the 4096 budget', async () => {
      const openai = new FakeAiProvider({ id: 'openai', responses: [{ outputText: '{"tags":[]}' }] });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const text = await provider.analyzeImage(
        { apiKey: KEY },
        {
          model: 'gpt-5.5',
          system: 'Tag it',
          prompt: 'What is shown?',
          images: [
            { base64: 'AAA', mimeType: 'image/jpeg' },
            { base64: 'BBB', mimeType: 'image/png' },
          ],
        },
      );

      expect(text).toBe('{"tags":[]}');
      const request = openai.calls.find((c) => c.method === 'responses.create')?.request;
      expect(request?.maxOutputTokens).toBe(4096);
      expect(request?.instructions).toBe('Tag it');
      expect(request?.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown?' },
            { type: 'image', url: 'data:image/jpeg;base64,AAA' },
            { type: 'image', url: 'data:image/png;base64,BBB' },
          ],
        },
      ]);
    });

    it('sends Anthropic the image first (single-image form) with the 1024 budget unless overridden', async () => {
      const anthropic = new FakeAiProvider({ id: 'anthropic', responses: [{ outputText: 'x' }, { outputText: 'y' }] });
      const provider = new LegacyAnthropicProvider(fakes({ anthropic }));

      await provider.analyzeImage({ apiKey: KEY }, { model: 'claude-x', prompt: 'p', imageBase64: 'CCC', mimeType: 'image/jpeg' });
      await provider.analyzeImage(
        { apiKey: KEY },
        { model: 'claude-x', prompt: 'p', imageBase64: 'CCC', mimeType: 'image/jpeg', maxTokens: 2048 },
      );

      const [first, second] = anthropic.calls.filter((c) => c.method === 'responses.create');
      expect(first.request?.maxOutputTokens).toBe(1024);
      expect(second.request?.maxOutputTokens).toBe(2048);
      expect((first.request?.input as Array<{ content: unknown[] }>)[0].content).toEqual([
        { type: 'image', url: 'data:image/jpeg;base64,CCC' },
        { type: 'text', text: 'p' },
      ]);
    });

    it('refuses a request with no image before any call', async () => {
      const set = fakes();
      const provider = new LegacyOpenAiProvider(set);
      await expect(provider.analyzeImage({ apiKey: KEY }, { model: 'm', prompt: 'p' })).rejects.toThrow(/imageBase64/);
      expect(set.openai.calls).toHaveLength(0);
    });
  });

  describe('embedText', () => {
    it('returns the one vector of the input', async () => {
      const openai = new FakeAiProvider({ id: 'openai', embeddingsPort: true, embeddingDimensions: 1536 });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const vector = await provider.embedText!({ apiKey: KEY }, 'text-embedding-3-small', 'a beach at dusk');

      expect(vector).toHaveLength(1536);
      expect(openai.calls[0]).toMatchObject({ method: 'embeddings.embed', apiKey: KEY });
    });

    it('is a plain error on Anthropic, as before', async () => {
      const provider = new LegacyAnthropicProvider(fakes());
      expect(() => provider.embedText!({ apiKey: KEY }, 'm', 'x')).toThrow('Anthropic does not support text embeddings');
    });
  });

  describe('enhanceImage', () => {
    it('sends the bytes to the image-edit port with input_fidelity on the OpenAI escape hatch', async () => {
      const edit = jest.fn().mockResolvedValue({
        provider: 'openai',
        model: 'gpt-image-1',
        usage: {},
        images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }],
      });
      const openai = new FakeAiProvider({
        id: 'openai',
        ports: { images: { generate: jest.fn(), edit } },
      });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const result = await provider.enhanceImage!(
        { apiKey: KEY },
        {
          model: 'gpt-image-1',
          imageBase64: Buffer.from('raw').toString('base64'),
          mimeType: 'image/jpeg',
          prompt: 'restore',
          size: '1536x1024',
          quality: 'high',
          inputFidelity: 'high',
          outputCompression: 90,
        },
      );

      expect(result).toEqual({ imageBase64: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/jpeg' });
      const [req, ctx] = edit.mock.calls[0];
      expect(ctx.apiKey).toBe(KEY);
      expect(req).toMatchObject({
        model: 'gpt-image-1',
        prompt: 'restore',
        size: '1536x1024',
        quality: 'high',
        outputFormat: 'jpeg',
        n: 1,
        providerOptions: { openai: { input_fidelity: 'high', output_compression: 90 } },
      });
      expect(Buffer.from(req.images[0].data).toString()).toBe('raw');
    });

    it('rejects an empty result', async () => {
      const edit = jest.fn().mockResolvedValue({ provider: 'openai', model: 'm', usage: {}, images: [] });
      const openai = new FakeAiProvider({ id: 'openai', ports: { images: { generate: jest.fn(), edit } } });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));
      await expect(
        provider.enhanceImage!({ apiKey: KEY }, {
          model: 'gpt-image-1', imageBase64: 'AA==', mimeType: 'image/png', prompt: 'p',
          size: '1024x1024', quality: 'low', inputFidelity: 'low',
        }),
      ).rejects.toThrow('returned no image data');
    });
  });

  describe('transcribeAudio', () => {
    it('sends the bounded audio bytes and trims the transcript', async () => {
      const transcribe = jest.fn().mockResolvedValue({
        provider: 'openai', model: 'gpt-4o-mini-transcribe', usage: {}, text: '  hello world \n', language: 'en',
      });
      const openai = new FakeAiProvider({ id: 'openai', ports: { audio: { transcribe } } });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));

      const result = await provider.transcribeAudio!(
        { apiKey: KEY },
        { model: 'gpt-4o-mini-transcribe', audio: Buffer.from('aud'), mimeType: 'audio/mp4', language: 'es' },
      );

      expect(result).toEqual({ text: 'hello world', language: 'en' });
      const [req] = transcribe.mock.calls[0];
      expect(req).toMatchObject({ model: 'gpt-4o-mini-transcribe', language: 'es' });
      expect(req.audio).toMatchObject({ mimeType: 'audio/mp4', filename: 'audio.m4a' });
    });

    it('is absent on Anthropic, so callers degrade to visual-only', () => {
      const provider = new LegacyAnthropicProvider(fakes());
      expect((provider as { transcribeAudio?: unknown }).transcribeAudio).toBeUndefined();
      expect((provider as { enhanceImage?: unknown }).enhanceImage).toBeUndefined();
    });
  });

  describe('endpoint routing and model lists', () => {
    it('sends an OpenAI credential with a custom baseUrl to the compatible adapter (Chat Completions)', async () => {
      const set = fakes({ openaiCompatible: new FakeAiProvider({ id: 'openai-compatible', responses: [{ outputText: 'x' }] }) });
      const provider = new LegacyOpenAiProvider(set);

      await provider.analyzeImage(
        { apiKey: KEY, baseUrl: 'https://llm.example.test/v1' },
        { model: 'any-model', prompt: 'p', imageBase64: 'AA', mimeType: 'image/jpeg' },
      );

      expect(set.openai.calls).toHaveLength(0);
      expect(set.openaiCompatible.calls[0]).toMatchObject({
        baseUrl: 'https://llm.example.test/v1',
        providerSettings: { apiStyle: 'chat_completions', requiresKey: true },
      });
      expect(isCustomOpenAiEndpoint('https://api.openai.com/v1')).toBe(false);
      expect(isCustomOpenAiEndpoint(undefined)).toBe(false);
    });

    it('lists GPT >= 5.4 chat models, the curated list without a key, and all ids at a compatible endpoint', async () => {
      const set = fakes({
        openai: new FakeAiProvider({ id: 'openai', models: ['gpt-5.5', 'gpt-4o', 'text-embedding-3-small', 'gpt-5.4-mini'] }),
        openaiCompatible: new FakeAiProvider({ id: 'openai-compatible', models: ['llama-3', 'qwen'] }),
      });
      const provider = new LegacyOpenAiProvider(set);

      await expect(provider.listModels({ apiKey: '' })).resolves.toEqual(['gpt-5.4', 'gpt-5.5']);
      await expect(provider.listModels({ apiKey: KEY })).resolves.toEqual(['gpt-5.4-mini', 'gpt-5.5']);
      await expect(provider.listModels({ apiKey: KEY, baseUrl: 'http://ollama.example.test' })).resolves.toEqual([
        'llama-3',
        'qwen',
      ]);
      expect(provider.listEmbeddingModels()).toEqual(['text-embedding-3-small', 'text-embedding-3-large']);
      expect(provider.listImageModels()).toEqual(['gpt-image-1']);
      expect(provider.listTranscriptionModels()).toEqual(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']);
      expect(isEligibleOpenAiModel('gpt-5.10')).toBe(true);
      expect(isEligibleOpenAiModel('gpt-5.5-realtime')).toBe(false);
    });

    it('reports a rejected key from testModel as an answer, never a throw', async () => {
      const openai = new FakeAiProvider({ id: 'openai', validKeys: ['sk-other'] });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));
      await expect(provider.testModel({ apiKey: KEY }, 'gpt-5.5')).resolves.toEqual({ ok: false, error: 'Invalid API key' });
    });
  });

  describe('errors', () => {
    it('turns a platform rate limit into status 429 with a retry-after the queue defers on', () => {
      const legacy = toLegacyProviderError(new AiError('AI_RATE_LIMITED', 'limited', { retryAfterMs: 2500 }));
      expect(legacy.status).toBe(429);
      expect(legacy.headers).toEqual({ 'retry-after': '3' });
      const classified = classifyRateLimit(legacy);
      expect(classified?.retryAfterMs).toBe(3000);
    });

    it('keeps an overloaded provider status (529) so the queue still defers it', () => {
      const legacy = toLegacyProviderError(
        new AiError('AI_PROVIDER_UNAVAILABLE', 'overloaded', { details: { status: 529 } }),
      );
      expect(legacy.status).toBe(529);
      expect(classifyRateLimit(legacy)).not.toBeNull();
    });

    it('names an invalid key and a missing model, and never classifies them as a rate limit', () => {
      expect(toLegacyProviderError(new AiError('AI_KEY_INVALID', 'x')).message).toBe('Invalid API key');
      const missing = toLegacyProviderError(new AiError('AI_INVALID_REQUEST', 'x', { details: { status: 404 } }), 'gpt-9');
      expect(missing.message).toBe('Model not found: gpt-9');
      expect(classifyRateLimit(missing)).toBeNull();
    });

    it('surfaces a provider failure from analyzeImage in the legacy shape', async () => {
      const openai = new FakeAiProvider({
        id: 'openai',
        responses: () => {
          throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1000 });
        },
      });
      const provider = new LegacyOpenAiProvider(fakes({ openai }));
      await expect(
        provider.analyzeImage({ apiKey: KEY }, { model: 'gpt-5.5', prompt: 'p', imageBase64: 'AA', mimeType: 'image/jpeg' }),
      ).rejects.toMatchObject({ status: 429, headers: { 'retry-after': '1' } });
    });

    it('passes a non-platform error through unchanged', () => {
      const plain = new Error('boom');
      expect(toLegacyProviderError(plain)).toBe(plain);
    });
  });

  it('maps a plain system message to a system input item', () => {
    expect(toInputItems([{ role: 'system', content: 's' }])).toEqual([
      { type: 'message', role: 'system', content: [{ type: 'text', text: 's' }] },
    ]);
  });
});
