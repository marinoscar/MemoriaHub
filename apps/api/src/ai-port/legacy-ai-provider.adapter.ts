// =============================================================================
// MemoriaHub's legacy AI providers over the platform adapters (RETRO-E1, #595)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#595): every MemoriaHub AI call site still speaks the
// legacy provider contract (`legacy-ai-provider.types.ts`: `chat`,
// `analyzeImage`, `embedText`, `enhanceImage`, `transcribeAudio`, `listModels`,
// `testModel`) and hands it a key it read itself from `ai_provider_credentials`
// (`AiSettingsService.resolveCredentials`). This file keeps that contract
// working with NO provider SDK in `apps/`: each method is implemented on top of
// the platform's framework-free provider adapters
// (`@marinoscar/platform-ai-providers`, the package that owns the `openai` and
// `@anthropic-ai/sdk` imports), so the `ai-no-sdk-leak` suite holds.
//
// WHY NOT `AiService.forUser(...)` YET. The facade resolves the key itself
// (`AiKeyResolver`: user, organization, deployment) from the PLATFORM key store,
// which is empty until RETRO-E3 release 1 imports `ai_provider_credentials`;
// and two capabilities MemoriaHub needs have no synchronous, bytes-in form on
// the facade (`editImage` and `transcribe` queue a background run over a
// storage object the calling USER owns; the enhancer and video tagging hold
// bytes in a system job). So until E2/E3 the adapter runs the same provider
// adapters the facade would, under the legacy key (the "legacy key reader"
// fallback the issue describes). Seam gaps: see local-exceptions.md.
//
// BEHAVIOUR KEPT, field for field:
//   - curated model lists and the GPT >= 5.4 chat filter (`listModels`, the
//     embedding / image / transcription lists);
//   - an OpenAI credential with a non-OpenAI `baseUrl` (Moonshot, Together,
//     Ollama, ...) talks Chat Completions through the platform's
//     OpenAI-compatible adapter, exactly as the old provider did;
//   - token budgets: vision 4096 (OpenAI, reasoning effort `low` when the model
//     reasons) / 1024 (Anthropic) unless the caller sets `maxTokens`; Anthropic
//     chat 16000; the connectivity probe 1024 / 1;
//   - `temperature` only when the caller sets it; one tool call per OpenAI turn;
//   - ERRORS: every failure is an `Error` carrying the provider's HTTP `status`
//     (429 for `AI_RATE_LIMITED`, the recorded status otherwise, so Anthropic's
//     529 stays 529) and a plain `headers['retry-after']`, which is what
//     `classifyRateLimit` (`enrichment/rate-limit.error.ts`) reads to DEFER a
//     job instead of charging an attempt. 401 reads "Invalid API key", 404
//     "Model not found: <model>". The key is never in a message (the platform
//     adapters' messages are fixed strings).
//
// Removed by RETRO-E2 (each call site moves to `AiService.forUser`), once
// RETRO-E3 release 1 has imported the keys.
// =============================================================================

import { z } from 'zod';
import {
  AiError,
  type AiCallContext,
  type AiInputItem,
  type AiContentPart,
  type AiProviderAdapter,
  type AiResponseRequest,
  type AiTool,
} from '@marinoscar/platform-ai-providers';
import {
  createOpenAiAdapter,
  createOpenAiCompatibleAdapter,
} from '@marinoscar/platform-ai-providers/openai';
import { createAnthropicAdapter } from '@marinoscar/platform-ai-providers/anthropic';

import type {
  AiProvider,
  AiProviderCredentials,
  AiToolDef,
  AnalyzeImageRequest,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  EnhanceImageRequest,
  EnhanceImageResult,
  TranscribeAudioRequest,
  TranscribeAudioResult,
} from './legacy-ai-provider.types';

// -----------------------------------------------------------------------------
// Model lists and budgets (unchanged from the SDK-backed providers)
// -----------------------------------------------------------------------------

/** Shown when no OpenAI key is configured yet, so the UI still has a selection. */
const OPENAI_CURATED_MODELS = ['gpt-5.4', 'gpt-5.5'] as const;
const OPENAI_EMBEDDING_MODELS = ['text-embedding-3-small', 'text-embedding-3-large'] as const;
const OPENAI_IMAGE_MODELS = ['gpt-image-1'] as const;
const OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'whisper-1',
] as const;
const ANTHROPIC_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';

const OPENAI_VISION_MAX_TOKENS = 4096;
const ANTHROPIC_VISION_MAX_TOKENS = 1024;
const ANTHROPIC_CHAT_MAX_TOKENS = 16000;
const OPENAI_TEST_MAX_TOKENS = 1024;
const ANTHROPIC_TEST_MAX_TOKENS = 1;

/**
 * `low` is the lowest reasoning tier every GPT-5.x model the picker allows
 * accepts. Sent only to a model the adapter classifies as reasoning, so a
 * non-reasoning model never receives a parameter it would reject.
 */
const OPENAI_REASONING_EFFORT = (process.env['OPENAI_REASONING_EFFORT'] ?? 'low') as
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high';

/** Container extension OpenAI infers the audio format from, keyed by MIME. */
const AUDIO_EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

/**
 * Returns true for OpenAI chat model ids with a GPT major.minor of 5.4 or
 * greater that are not a non-text modality (embeddings, audio, realtime, TTS,
 * image generation, moderation, search). Mini and nano variants are included.
 */
export function isEligibleOpenAiModel(id: string): boolean {
  if (
    /embedding|audio|realtime|tts|whisper|transcribe|image|dall-?e|moderation|search/i.test(id)
  ) {
    return false;
  }
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = m[2] ? parseInt(m[2], 10) : 0;
  return major > 5 || (major === 5 && minor >= 4);
}

/** True when `baseUrl` points somewhere other than OpenAI's own API. */
export function isCustomOpenAiEndpoint(baseUrl: string | undefined): boolean {
  return !!baseUrl && !/(^|\/\/)api\.openai\.com/i.test(baseUrl);
}

// -----------------------------------------------------------------------------
// Errors: AiError -> the legacy shape `classifyRateLimit` reads
// -----------------------------------------------------------------------------

/** The legacy error: a message, the provider status and a plain `retry-after`. */
export type LegacyAiProviderError = Error & {
  status?: number;
  code?: string;
  headers?: Record<string, string>;
};

/**
 * Turns anything a platform adapter threw into the error the legacy call sites
 * expect. `AI_RATE_LIMITED` becomes status 429; an otherwise-recorded provider
 * status (Anthropic's 529 "overloaded" arrives as `AI_PROVIDER_UNAVAILABLE`
 * with `details.status: 529`) is kept, so the queue still defers it. The
 * `AiError` code rides on `code`, the original error on `cause`.
 */
export function toLegacyProviderError(err: unknown, model?: string): LegacyAiProviderError {
  if (!(err instanceof AiError)) {
    return (err instanceof Error ? err : new Error(String(err))) as LegacyAiProviderError;
  }
  const details = (err.getResponse().details ?? {}) as Record<string, unknown>;
  const recorded = typeof details['status'] === 'number' ? (details['status'] as number) : undefined;
  const status = err.code === 'AI_RATE_LIMITED' ? 429 : recorded;

  let message = err.message;
  if (err.code === 'AI_KEY_INVALID' || status === 401) message = 'Invalid API key';
  else if (status === 404 || details['providerCode'] === 'model_not_found') {
    message = model ? `Model not found: ${model}` : 'Model not found';
  }

  const legacy = new Error(message, { cause: err }) as LegacyAiProviderError;
  legacy.code = err.code;
  if (status !== undefined) legacy.status = status;
  if (err.retryAfterMs !== undefined) {
    legacy.headers = { 'retry-after': String(Math.max(0, Math.ceil(err.retryAfterMs / 1000))) };
  }
  return legacy;
}

// -----------------------------------------------------------------------------
// Request mapping
// -----------------------------------------------------------------------------

function textPart(text: string): AiContentPart {
  return { type: 'text', text };
}

/** Legacy chat history -> the platform's provider-neutral input items. */
export function toInputItems(messages: readonly ChatMessage[]): AiInputItem[] {
  const items: AiInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', callId: m.toolCallId ?? '', output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) items.push({ type: 'message', role: 'assistant', content: [textPart(m.content)] });
      for (const call of m.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          callId: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        });
      }
      continue;
    }
    items.push({ type: 'message', role: m.role, content: [textPart(m.content)] });
  }
  return items;
}

/**
 * A legacy tool (a JSON Schema document) as a platform function tool (a Zod
 * schema, converted back to JSON Schema by the adapter). `strict: false`: the
 * old providers never asked for strict function calling, so an optional
 * argument stays optional.
 */
export function toFunctionTool(tool: AiToolDef): AiTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
    strict: false,
  };
}

function base64Bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// -----------------------------------------------------------------------------
// The providers
// -----------------------------------------------------------------------------

/** The platform adapters the legacy providers run on (injectable for tests). */
export interface LegacyAdapterSet {
  openai: AiProviderAdapter;
  openaiCompatible: AiProviderAdapter;
  anthropic: AiProviderAdapter;
}

/** The framework-free platform adapters, built once per process. */
export function createLegacyAdapterSet(): LegacyAdapterSet {
  return {
    openai: createOpenAiAdapter(),
    openaiCompatible: createOpenAiCompatibleAdapter(),
    anthropic: createAnthropicAdapter(),
  };
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `legacy-ai-${Date.now().toString(36)}-${requestSeq}`;
}

/**
 * The shared half of both providers: one platform adapter per call, picked from
 * the credential (an OpenAI credential with a custom `baseUrl` goes to the
 * OpenAI-compatible adapter in Chat Completions style).
 */
abstract class LegacyPlatformProvider {
  protected constructor(protected readonly adapters: LegacyAdapterSet) {}

  protected abstract adapterFor(creds: AiProviderCredentials): AiProviderAdapter;

  protected ctx(creds: AiProviderCredentials): AiCallContext {
    const custom = this.adapterFor(creds) === this.adapters.openaiCompatible;
    return {
      apiKey: creds.apiKey,
      requestId: nextRequestId(),
      ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
      ...(custom ? { providerSettings: { apiStyle: 'chat_completions', requiresKey: true } } : {}),
    };
  }

  /** The adapter's responses port, or a capability error in the legacy shape. */
  protected responsesOf(adapter: AiProviderAdapter) {
    if (!adapter.responses) {
      throw new Error(`Provider "${adapter.id}" has no responses capability`);
    }
    return adapter.responses;
  }

  /** `providerOptions` keyed by the adapter's own provider id. */
  protected providerOptions(
    adapter: AiProviderAdapter,
    options: Record<string, unknown>,
  ): AiResponseRequest['providerOptions'] {
    return Object.keys(options).length > 0 ? { [adapter.id]: options } : undefined;
  }

  protected async *streamChat(
    adapter: AiProviderAdapter,
    creds: AiProviderCredentials,
    request: AiResponseRequest,
  ): AsyncIterable<ChatStreamEvent> {
    const emitted = new Set<string>();
    const toolCall = (callId: string, name: string, args: string): ChatStreamEvent => {
      emitted.add(callId);
      let input: unknown = {};
      try {
        input = args ? JSON.parse(args) : {};
      } catch {
        // Malformed JSON from the model: an empty object, as before.
      }
      return { type: 'tool_call', id: callId, name, input };
    };

    try {
      for await (const event of this.responsesOf(adapter).stream(request, this.ctx(creds))) {
        switch (event.type) {
          case 'output_text.delta':
            if (event.delta) yield { type: 'text', text: event.delta };
            break;
          case 'output_item.done':
            if (event.item.type === 'function_call' && !emitted.has(event.item.callId)) {
              yield toolCall(event.item.callId, event.item.name, event.item.arguments);
            }
            break;
          case 'response.completed':
            for (const item of event.response.output) {
              if (item.type === 'function_call' && !emitted.has(item.callId)) {
                yield toolCall(item.callId, item.name, item.arguments);
              }
            }
            yield { type: 'done', stopReason: event.response.finishReason };
            break;
          case 'error':
            throw new AiError(event.code, event.message);
          default:
            break;
        }
      }
    } catch (err) {
      throw toLegacyProviderError(err, request.model);
    }
  }

  protected async respondText(
    adapter: AiProviderAdapter,
    creds: AiProviderCredentials,
    request: AiResponseRequest,
  ): Promise<string> {
    try {
      const response = await this.responsesOf(adapter).create(request, this.ctx(creds));
      return response.outputText;
    } catch (err) {
      throw toLegacyProviderError(err, request.model);
    }
  }

  protected async probe(
    adapter: AiProviderAdapter,
    creds: AiProviderCredentials,
    request: AiResponseRequest,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.responsesOf(adapter).create(request, this.ctx(creds));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toLegacyProviderError(err, request.model).message || 'Unknown error' };
    }
  }

  protected visionInput(req: AnalyzeImageRequest, imagesFirst: boolean): AiInputItem[] {
    const images =
      req.images && req.images.length > 0
        ? req.images
        : req.imageBase64
          ? [{ base64: req.imageBase64, mimeType: req.mimeType ?? 'image/jpeg' }]
          : [];
    if (images.length === 0) {
      throw new Error('analyzeImage needs imageBase64 or a non-empty images array');
    }
    const imageParts: AiContentPart[] = images.map((image) => ({
      type: 'image',
      url: `data:${image.mimeType};base64,${image.base64}`,
    }));
    const content = imagesFirst
      ? [...imageParts, textPart(req.prompt)]
      : [textPart(req.prompt), ...imageParts];
    return [{ type: 'message', role: 'user', content }];
  }
}

/** The legacy `openai` provider: OpenAI, or an OpenAI-compatible endpoint by `baseUrl`. */
export class LegacyOpenAiProvider extends LegacyPlatformProvider implements AiProvider {
  readonly key = 'openai';

  constructor(adapters: LegacyAdapterSet) {
    super(adapters);
  }

  protected adapterFor(creds: AiProviderCredentials): AiProviderAdapter {
    return isCustomOpenAiEndpoint(creds.baseUrl) ? this.adapters.openaiCompatible : this.adapters.openai;
  }

  /** Reasoning effort only for a model the adapter knows reasons. */
  private reasoningFor(adapter: AiProviderAdapter, model: string): AiResponseRequest['reasoning'] {
    if (adapter !== this.adapters.openai) return undefined;
    const caps = adapter.classifyModel(model);
    return caps?.capabilities.includes('reasoning') ? { effort: OPENAI_REASONING_EFFORT } : undefined;
  }

  chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const adapter = this.adapterFor(creds);
    const tools = req.tools && req.tools.length > 0 ? req.tools.map(toFunctionTool) : undefined;
    return this.streamChat(adapter, creds, {
      model: req.model,
      ...(req.system ? { instructions: req.system } : {}),
      input: toInputItems(req.messages),
      ...(tools ? { tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // One tool call per turn keeps the assistant + tool-result append valid.
      providerOptions: this.providerOptions(adapter, tools ? { parallel_tool_calls: false } : {}),
    });
  }

  async listModels(creds: AiProviderCredentials): Promise<string[]> {
    if (!creds.apiKey) return [...OPENAI_CURATED_MODELS];
    const adapter = this.adapterFor(creds);
    try {
      const ids = (await adapter.listModels(this.ctx(creds))).map((m) => m.id);
      // A compatible endpoint's ids are its own: no GPT filter.
      if (adapter === this.adapters.openaiCompatible) return ids.sort();
      const eligible = ids.filter(isEligibleOpenAiModel).sort();
      return eligible.length > 0 ? eligible : [...OPENAI_CURATED_MODELS];
    } catch {
      return [...OPENAI_CURATED_MODELS];
    }
  }

  listEmbeddingModels(): string[] {
    return [...OPENAI_EMBEDDING_MODELS];
  }

  listImageModels(): string[] {
    return [...OPENAI_IMAGE_MODELS];
  }

  listTranscriptionModels(): string[] {
    return [...OPENAI_TRANSCRIPTION_MODELS];
  }

  testModel(creds: AiProviderCredentials, model: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapterFor(creds);
    const reasoning = this.reasoningFor(adapter, model);
    return this.probe(adapter, creds, {
      model,
      input: 'hi',
      maxOutputTokens: OPENAI_TEST_MAX_TOKENS,
      ...(reasoning ? { reasoning } : {}),
    });
  }

  analyzeImage(creds: AiProviderCredentials, req: AnalyzeImageRequest): Promise<string> {
    const adapter = this.adapterFor(creds);
    const reasoning = this.reasoningFor(adapter, req.model);
    return this.respondText(adapter, creds, {
      model: req.model,
      ...(req.system ? { instructions: req.system } : {}),
      // Text first, then the images: the order the OpenAI path always sent.
      input: this.visionInput(req, false),
      maxOutputTokens: req.maxTokens ?? OPENAI_VISION_MAX_TOKENS,
      ...(reasoning ? { reasoning } : {}),
    });
  }

  async embedText(creds: AiProviderCredentials, model: string, input: string): Promise<number[]> {
    const adapter = this.adapterFor(creds);
    if (!adapter.embeddings) throw new Error('Provider "openai" has no embeddings capability');
    try {
      const result = await adapter.embeddings.embed({ model, input }, this.ctx(creds));
      return result.vectors[0] ?? [];
    } catch (err) {
      throw toLegacyProviderError(err, model);
    }
  }

  async enhanceImage(creds: AiProviderCredentials, req: EnhanceImageRequest): Promise<EnhanceImageResult> {
    const adapter = this.adapterFor(creds);
    const edit = adapter.images?.edit?.bind(adapter.images);
    if (!edit) throw new Error('Provider "openai" has no image-edit capability at this endpoint');
    const outputFormat = req.outputFormat ?? 'jpeg';
    const ext = req.mimeType === 'image/png' ? 'png' : 'jpg';
    try {
      const result = await edit(
        {
          model: req.model,
          prompt: req.prompt,
          images: [{ data: base64Bytes(req.imageBase64), mimeType: req.mimeType, filename: `input.${ext}` }],
          size: req.size,
          quality: req.quality,
          outputFormat,
          n: 1,
          // `input_fidelity` and `output_compression` have no neutral field: they
          // ride the OpenAI escape hatch, merged into the `/v1/images/edits` body.
          providerOptions: {
            [adapter.id]: {
              input_fidelity: req.inputFidelity,
              ...(req.outputCompression !== undefined ? { output_compression: req.outputCompression } : {}),
            },
          },
        },
        this.ctx(creds),
      );
      const image = result.images[0];
      if (!image || image.data.byteLength === 0) {
        throw new Error('OpenAI image edit returned no image data');
      }
      return {
        imageBase64: Buffer.from(image.data).toString('base64'),
        mimeType: outputFormat === 'png' ? 'image/png' : 'image/jpeg',
      };
    } catch (err) {
      throw toLegacyProviderError(err, req.model);
    }
  }

  async transcribeAudio(creds: AiProviderCredentials, req: TranscribeAudioRequest): Promise<TranscribeAudioResult> {
    const adapter = this.adapterFor(creds);
    const transcribe = adapter.audio?.transcribe?.bind(adapter.audio);
    if (!transcribe) throw new Error('Provider "openai" has no transcription capability at this endpoint');
    const ext = AUDIO_EXT_BY_MIME[req.mimeType] ?? 'm4a';
    try {
      const result = await transcribe(
        {
          model: req.model,
          audio: { data: new Uint8Array(req.audio), mimeType: req.mimeType, filename: `audio.${ext}` },
          ...(req.language ? { language: req.language } : {}),
        },
        this.ctx(creds),
      );
      return { text: result.text.trim(), ...(result.language ? { language: result.language } : {}) };
    } catch (err) {
      throw toLegacyProviderError(err, req.model);
    }
  }
}

/** The legacy `anthropic` provider. No embeddings, image edit or audio. */
export class LegacyAnthropicProvider extends LegacyPlatformProvider implements AiProvider {
  readonly key = 'anthropic';

  constructor(adapters: LegacyAdapterSet) {
    super(adapters);
  }

  protected adapterFor(): AiProviderAdapter {
    return this.adapters.anthropic;
  }

  chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const tools = req.tools && req.tools.length > 0 ? req.tools.map(toFunctionTool) : undefined;
    return this.streamChat(this.adapters.anthropic, creds, {
      model: req.model || ANTHROPIC_DEFAULT_MODEL,
      ...(req.system ? { instructions: req.system } : {}),
      input: toInputItems(req.messages),
      ...(tools ? { tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      maxOutputTokens: ANTHROPIC_CHAT_MAX_TOKENS,
    });
  }

  async listModels(creds: AiProviderCredentials): Promise<string[]> {
    if (!creds.apiKey) return [...ANTHROPIC_MODELS];
    try {
      const models = await this.adapters.anthropic.listModels(this.ctx(creds));
      return models.map((m) => m.id).sort();
    } catch {
      return [...ANTHROPIC_MODELS];
    }
  }

  testModel(creds: AiProviderCredentials, model: string): Promise<{ ok: boolean; error?: string }> {
    return this.probe(this.adapters.anthropic, creds, {
      model,
      input: 'hi',
      maxOutputTokens: ANTHROPIC_TEST_MAX_TOKENS,
    });
  }

  analyzeImage(creds: AiProviderCredentials, req: AnalyzeImageRequest): Promise<string> {
    return this.respondText(this.adapters.anthropic, creds, {
      model: req.model,
      ...(req.system ? { instructions: req.system } : {}),
      // Images first, then the text: the order the Anthropic path always sent.
      input: this.visionInput(req, true),
      maxOutputTokens: req.maxTokens ?? ANTHROPIC_VISION_MAX_TOKENS,
    });
  }

  embedText(_creds: AiProviderCredentials, _model: string, _input: string): Promise<number[]> {
    throw new Error('Anthropic does not support text embeddings');
  }
}
