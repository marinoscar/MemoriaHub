import Anthropic from '@anthropic-ai/sdk';
import { callAnthropicVision } from '@memoriahub/enrichment-compute/ai';
import type {
  AiProvider,
  AiProviderCredentials,
  AnalyzeImageRequest,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
} from './ai-provider.interface';

// =============================================================================
// Anthropic Provider — model constants (update here to add/remove models)
// =============================================================================

const ANTHROPIC_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';

export class AnthropicProvider implements AiProvider {
  readonly key = 'anthropic';

  async *chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const client = new Anthropic({ apiKey: creds.apiKey });

    // Map ChatMessage[] to Anthropic MessageParam format.
    // Consecutive tool-result messages must be batched into a single user turn.
    const rawParams = req.messages.filter((m: ChatMessage) => m.role !== 'system');
    const messages: Anthropic.MessageParam[] = [];
    for (const m of rawParams) {
      if (m.role === 'tool') {
        // Tool result → role:'user' with tool_result content block.
        // If the previous message is already a user message that contains only
        // tool_result blocks, batch into it (Anthropic requires all tool results
        // for a single assistant turn to appear in ONE user message).
        const prev = messages[messages.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result' as const,
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        };
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          (prev.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
        } else {
          messages.push({ role: 'user' as const, content: [toolResultBlock] });
        }
        continue;
      }

      if (m.role === 'assistant') {
        // If this assistant turn invoked tools, include tool_use content blocks
        // so the subsequent tool_result user message is valid.
        if (m.toolCalls && m.toolCalls.length > 0) {
          const content: Anthropic.ContentBlock[] = [];
          if (m.content) {
            content.push({ type: 'text' as const, text: m.content } as Anthropic.TextBlock);
          }
          for (const tc of m.toolCalls) {
            content.push({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              input: tc.input ?? {},
            } as Anthropic.ToolUseBlock);
          }
          messages.push({ role: 'assistant' as const, content });
          continue;
        }
        messages.push({ role: 'assistant' as const, content: m.content });
        continue;
      }

      messages.push({ role: m.role as 'user', content: m.content });
    }

    // Map AiToolDef[] to Anthropic Tool format
    const tools: Anthropic.Tool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          }))
        : undefined;

    const streamParams: Anthropic.MessageStreamParams = {
      model: req.model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 16000,
      messages,
      ...(req.system && { system: req.system }),
      ...(tools && { tools }),
    };

    const stream = client.messages.stream(streamParams);

    // Track active tool_use blocks by index
    const toolUseBlocks: Record<number, { id: string; name: string; inputJson: string }> = {};

    for await (const event of stream) {
      // Text delta
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', text: event.delta.text };
        continue;
      }

      // Tool use block start — capture id and name
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        toolUseBlocks[event.index] = {
          id: event.content_block.id,
          name: event.content_block.name,
          inputJson: '',
        };
        continue;
      }

      // Input JSON delta — accumulate JSON for the tool call
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta'
      ) {
        const block = toolUseBlocks[event.index];
        if (block) {
          block.inputJson += event.delta.partial_json;
        }
        continue;
      }

      // Content block stop — emit completed tool call
      if (event.type === 'content_block_stop') {
        const block = toolUseBlocks[event.index];
        if (block) {
          let input: unknown = {};
          try {
            input = block.inputJson ? JSON.parse(block.inputJson) : {};
          } catch {
            // Malformed JSON — emit empty object
          }
          yield { type: 'tool_call', id: block.id, name: block.name, input };
          delete toolUseBlocks[event.index];
        }
        continue;
      }

      // Stream end
      if (event.type === 'message_stop') {
        const finalMessage = await stream.finalMessage();
        yield { type: 'done', stopReason: finalMessage.stop_reason ?? undefined };
      }
    }
  }

  async listModels(creds: AiProviderCredentials): Promise<string[]> {
    // No API key yet — return the curated fallback so the UI still has options
    if (!creds.apiKey) {
      return [...ANTHROPIC_MODELS];
    }

    try {
      const client = new Anthropic({
        apiKey: creds.apiKey,
        ...(creds.baseUrl && { baseURL: creds.baseUrl }),
      });

      // Auto-paginate through the full model catalog via the Models API
      const ids: string[] = [];
      for await (const m of client.models.list()) {
        ids.push(m.id);
      }
      return ids.sort();
    } catch {
      // On any network or auth error fall back to the curated list
      return [...ANTHROPIC_MODELS];
    }
  }

  async testModel(
    creds: AiProviderCredentials,
    model: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new Anthropic({ apiKey: creds.apiKey });
      await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof Anthropic.AuthenticationError) {
        return { ok: false, error: 'Invalid API key' };
      }
      if (err instanceof Anthropic.NotFoundError) {
        return { ok: false, error: `Model not found: ${model}` };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: message };
    }
  }

  async analyzeImage(
    creds: AiProviderCredentials,
    req: AnalyzeImageRequest,
  ): Promise<string> {
    // Delegates to the shared parity package so the server and distributed
    // worker nodes (which call callAnthropicVision directly with a
    // transiently-fetched API key — see NodesService.getJobCredentials)
    // send byte-identical requests. See @memoriahub/enrichment-compute/ai.
    return callAnthropicVision(creds, req);
  }

  embedText(_creds: AiProviderCredentials, _model: string, _input: string): Promise<number[]> {
    throw new Error('Anthropic does not support text embeddings');
  }
}
