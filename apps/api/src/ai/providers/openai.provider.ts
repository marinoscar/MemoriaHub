import OpenAI from 'openai';
import type {
  AiProvider,
  AiProviderCredentials,
  AnalyzeImageRequest,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
} from './ai-provider.interface';

// =============================================================================
// OpenAI Provider — model constants (update here to add/remove curated models)
// =============================================================================
//
// Token budget constants for non-streaming calls.
// GPT-5.x reasoning models consume tokens on hidden reasoning before producing
// visible output, so we cap reasoning effort and give extra headroom to ensure
// the JSON/text response always fits.
const TEST_MODEL_MAX_COMPLETION_TOKENS = 1024;
const ANALYZE_IMAGE_MAX_COMPLETION_TOKENS = 4096;
//
// 'low' is the lowest reasoning tier supported by every GPT-5.x model the
// picker allows (gpt-5.4 supports minimal/low/medium/high; gpt-5.5 supports
// none/low/medium/high — 'low' is the common floor). Override per-deployment
// if a model needs a different value.
const OPENAI_REASONING_EFFORT = process.env['OPENAI_REASONING_EFFORT'] ?? 'low';
//
// NOTE: To add an OpenAI-compatible provider (e.g. Moonshot, Together, Ollama):
//   no new code needed — store a credential record with the desired provider key
//   and set baseUrl to the compatible endpoint (e.g. 'https://api.moonshot.cn/v1').
//   This provider handles it automatically when baseUrl is set.
//
// Curated fallback list — GPT versions >= 5.4, including mini/nano variants.
// Shown when no API key is configured yet so the UI still has a selection.
const OPENAI_CURATED_MODELS = ['gpt-5.4', 'gpt-5.5'] as const;

const OPENAI_EMBEDDING_MODELS = ['text-embedding-3-small', 'text-embedding-3-large'] as const;

/**
 * Returns true for OpenAI chat/LLM model ids that have a GPT major.minor
 * version of 5.4 or greater AND are not a non-text modality (embeddings,
 * audio, realtime, TTS, image-generation, moderation, etc.).
 *
 * Mini and nano variants (e.g. gpt-5.4-mini, gpt-5.5-nano) are included
 * because they are text chat models — only modality keywords exclude a model.
 *
 * Exported so it can be unit-tested independently of the provider class.
 */
export function isEligibleOpenAiModel(id: string): boolean {
  // Exclude non-text / non-chat modalities by keyword
  if (
    /embedding|audio|realtime|tts|whisper|transcribe|image|dall-?e|moderation|search/i.test(id)
  ) {
    return false;
  }
  // Must match gpt-<major>[.<minor>]
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = m[2] ? parseInt(m[2], 10) : 0;
  // Greater than or equal to 5.4 — compare major/minor separately to avoid
  // floating-point issues with multi-digit minors (e.g. 5.10 > 5.4)
  return major > 5 || (major === 5 && minor >= 4);
}

export class OpenAiProvider implements AiProvider {
  readonly key = 'openai';

  async *chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const client = new OpenAI({
      apiKey: creds.apiKey,
      ...(creds.baseUrl && { baseURL: creds.baseUrl }),
    });

    // Map ChatMessage[] to OpenAI ChatCompletionMessageParam format
    const messages: OpenAI.ChatCompletionMessageParam[] = req.messages.map((m: ChatMessage) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: m.toolCallId ?? '',
          content: m.content,
        };
      }
      if (m.role === 'system') {
        return { role: 'system' as const, content: m.content };
      }
      if (m.role === 'assistant') {
        // If this assistant turn invoked tools, include structured tool_calls so
        // the subsequent tool-result messages are valid (OpenAI requires each
        // role:'tool' message to be preceded by an assistant message with a
        // matching tool_calls entry).
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant' as const,
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            })),
          };
        }
        return { role: 'assistant' as const, content: m.content };
      }
      return { role: 'user' as const, content: m.content };
    });

    // Map AiToolDef[] to OpenAI ChatCompletionTool format
    const tools: OpenAI.ChatCompletionTool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as Record<string, unknown>,
            },
          }))
        : undefined;

    const stream = await client.chat.completions.create({
      model: req.model,
      stream: true,
      messages,
      ...(tools && {
        tools,
        // Limit to one tool call per response so the per-tool assistant+result
        // append pattern stays valid across all turns.
        parallel_tool_calls: false,
      }),
    });

    // Accumulate tool call chunks across deltas — keyed by tool call index
    const toolCallAccumulators: Record<
      number,
      { id: string; name: string; argumentsJson: string }
    > = {};

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      const finishReason = choice.finish_reason;

      // Text delta
      if (delta.content) {
        yield { type: 'text', text: delta.content };
      }

      // Tool call deltas — accumulate across chunks
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulators[idx]) {
            toolCallAccumulators[idx] = {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              argumentsJson: '',
            };
          }
          const acc = toolCallAccumulators[idx];
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
        }
      }

      // When the model is done (including tool_calls finish reason), flush all accumulated tool calls
      if (finishReason) {
        for (const acc of Object.values(toolCallAccumulators)) {
          let input: unknown = {};
          try {
            input = acc.argumentsJson ? JSON.parse(acc.argumentsJson) : {};
          } catch {
            // Malformed JSON — emit empty object
          }
          yield { type: 'tool_call', id: acc.id, name: acc.name, input };
        }
        yield { type: 'done', stopReason: finishReason };
      }
    }
  }

  async listModels(creds: AiProviderCredentials): Promise<string[]> {
    // No API key yet — return the curated fallback so the UI still has options
    if (!creds.apiKey) {
      return [...OPENAI_CURATED_MODELS];
    }

    // Detect custom / OpenAI-compatible endpoints (e.g. Moonshot, Together).
    // The GPT-version filter is OpenAI-specific and must NOT be applied to them.
    const isCustomEndpoint =
      !!creds.baseUrl && !/(^|\/\/)api\.openai\.com/i.test(creds.baseUrl);

    try {
      const client = new OpenAI({
        apiKey: creds.apiKey,
        ...(creds.baseUrl && { baseURL: creds.baseUrl }),
      });
      const models = await client.models.list();
      const ids = models.data.map(m => m.id);

      if (isCustomEndpoint) {
        // Return all model ids from the compatible provider, sorted
        return ids.sort();
      }

      // Standard OpenAI: filter to chat models with GPT version >= 5.4
      const eligible = ids.filter(isEligibleOpenAiModel).sort();
      // Fall back to curated list if the API returned nothing recognisable
      return eligible.length > 0 ? eligible : [...OPENAI_CURATED_MODELS];
    } catch {
      return [...OPENAI_CURATED_MODELS];
    }
  }

  listEmbeddingModels(): string[] {
    return [...OPENAI_EMBEDDING_MODELS];
  }

  async testModel(
    creds: AiProviderCredentials,
    model: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new OpenAI({
        apiKey: creds.apiKey,
        ...(creds.baseUrl && { baseURL: creds.baseUrl }),
      });
      await client.chat.completions.create({
        model,
        // reasoning_effort:'low' keeps GPT-5.x reasoning models from spending the
        // full token budget on hidden reasoning during the connectivity probe.
        // 'low' is accepted by every GPT-5.x model (gpt-5.4 and gpt-5.5);
        // override via OPENAI_REASONING_EFFORT env var if needed.
        reasoning_effort: OPENAI_REASONING_EFFORT as any,
        max_completion_tokens: TEST_MODEL_MAX_COMPLETION_TOKENS,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e?.status === 401) {
        return { ok: false, error: 'Invalid API key' };
      }
      if (e?.status === 404 || e?.code === 'model_not_found') {
        return { ok: false, error: `Model not found: ${model}` };
      }
      return { ok: false, error: e?.message ?? 'Unknown error' };
    }
  }

  async analyzeImage(
    creds: AiProviderCredentials,
    req: AnalyzeImageRequest,
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: creds.apiKey,
      ...(creds.baseUrl && { baseURL: creds.baseUrl }),
    });

    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: req.prompt,
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${req.mimeType};base64,${req.imageBase64}`,
          },
        },
      ],
    });

    // Tagging is a short structured-classification task. reasoning_effort:'low'
    // keeps GPT-5.x reasoning models from spending the full token budget on
    // hidden reasoning, so the JSON output reliably fits in the response — and
    // it's faster/cheaper. 'low' is accepted by all allowed GPT-5.x models;
    // override via OPENAI_REASONING_EFFORT env var if needed.
    const response = await client.chat.completions.create({
      model: req.model,
      reasoning_effort: OPENAI_REASONING_EFFORT as any,
      max_completion_tokens: ANALYZE_IMAGE_MAX_COMPLETION_TOKENS,
      messages,
    });

    return response.choices[0]?.message?.content ?? '';
  }

  async embedText(
    creds: AiProviderCredentials,
    model: string,
    input: string,
  ): Promise<number[]> {
    try {
      const client = new OpenAI({
        apiKey: creds.apiKey,
        ...(creds.baseUrl && { baseURL: creds.baseUrl }),
      });
      const response = await client.embeddings.create({ model, input });
      return response.data[0].embedding;
    } catch (err: unknown) {
      const e = err as { status?: number; code?: string; message?: string };
      if (e?.status === 401) {
        throw new Error('Invalid API key');
      }
      if (e?.status === 404 || e?.code === 'model_not_found') {
        throw new Error(`Model not found: ${model}`);
      }
      throw new Error(e?.message ?? 'Unknown error calling OpenAI embeddings');
    }
  }
}
