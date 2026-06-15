import OpenAI from 'openai';
import type {
  AiProvider,
  AiProviderCredentials,
  ChatRequest,
  ChatStreamEvent,
} from './ai-provider.interface';

// =============================================================================
// OpenAI Provider — model constants (update here to add/remove curated models)
// =============================================================================
//
// NOTE: To add an OpenAI-compatible provider (e.g. Moonshot, Together, Ollama):
//   no new code needed — store a credential record with the desired provider key
//   and set baseUrl to the compatible endpoint (e.g. 'https://api.moonshot.cn/v1').
//   This provider handles it automatically when baseUrl is set.
//
const OPENAI_CURATED_MODELS = ['gpt-5', 'gpt-5.5'] as const;

export class OpenAiProvider implements AiProvider {
  readonly key = 'openai';

  async *chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const client = new OpenAI({
      apiKey: creds.apiKey,
      ...(creds.baseUrl && { baseURL: creds.baseUrl }),
    });

    // Map ChatMessage[] to OpenAI ChatCompletionMessageParam format
    const messages: OpenAI.ChatCompletionMessageParam[] = req.messages.map(m => {
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
      ...(tools && { tools }),
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
    // When baseUrl is set, attempt to list models from the compatible provider
    if (creds.baseUrl) {
      try {
        const client = new OpenAI({ apiKey: creds.apiKey, baseURL: creds.baseUrl });
        const models = await client.models.list();
        return models.data.map(m => m.id);
      } catch {
        return [...OPENAI_CURATED_MODELS];
      }
    }
    return [...OPENAI_CURATED_MODELS];
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
        max_tokens: 1,
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
}
