import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  AiError,
  AiService,
  type AiFunctionTool,
  type AiInputItem,
  type AiRequest,
  type AiStreamEvent,
} from '@marinoscar/platform-api/ai';
import { MEMORIAHUB_AI_FEATURES } from '../../ai-port/ai-features';
import { MemoriaHubAiSettings } from '../../ai-port/memoriahub-ai-settings';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchService } from '../search.service';
import { buildSearchMediaToolDef } from './search-tool-schema';

/** One turn of the conversation the agent keeps while it loops over tool calls. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolCallId?: string;
  toolName?: string;
}

/** Output budget the old Anthropic chat path always sent. */
const ANTHROPIC_CHAT_MAX_TOKENS = 16000;

/** The conversation as the platform's provider-neutral input items. */
function toInputItems(messages: readonly ChatMessage[]): AiInputItem[] {
  const items: AiInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', callId: m.toolCallId ?? '', output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: m.content }] });
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
    items.push({ type: 'message', role: m.role, content: [{ type: 'text', text: m.content }] });
  }
  return items;
}

/** A tool call the model made, as the agent runs it. */
interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The tool calls of one streamed response, in order, each once: from the `output_item.done`
 * events, with the completed response as the backstop. Malformed arguments become `{}`.
 */
async function* streamTextAndCalls(
  stream: AsyncIterable<AiStreamEvent>,
): AsyncGenerator<{ text: string } | { call: AgentToolCall }> {
  const emitted = new Set<string>();
  const call = (id: string, name: string, args: string): { call: AgentToolCall } => {
    emitted.add(id);
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = args ? JSON.parse(args) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      // Malformed JSON from the model: an empty object, as before.
    }
    return { call: { id, name, input } };
  };

  for await (const event of stream) {
    switch (event.type) {
      case 'output_text.delta':
        if (event.delta) yield { text: event.delta };
        break;
      case 'output_item.done':
        if (event.item.type === 'function_call' && !emitted.has(event.item.callId)) {
          yield call(event.item.callId, event.item.name, event.item.arguments);
        }
        break;
      case 'response.completed':
        for (const item of event.response.output) {
          if (item.type === 'function_call' && !emitted.has(item.callId)) {
            yield call(item.callId, item.name, item.arguments);
          }
        }
        return;
      case 'error':
        throw new AiError(event.code, event.message);
      default:
        break;
    }
  }
}

export type AgentSseEvent =
  | { event: 'tool_call'; data: { name: string; args: Record<string, unknown> } }
  | { event: 'token'; data: { text: string } }
  | { event: 'results'; data: { items: unknown[]; meta: unknown } }
  | { event: 'done'; data: Record<string, never> };

export interface AgentTurnParams {
  circleId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userId: string;
  permissions: string[];
}

const SYSTEM_PROMPT = `You are an intelligent media search assistant for MemoriaHub. You MUST search within ONLY the current circle's media.

Your behavior:
- Use the search_media tool to translate the user's natural-language request into filter calls.
- When results are found, summarize them helpfully: total count, date range of captures, notable locations.
- When NO results match, say so plainly and suggest 1-3 adjacent searches the user could try (e.g., nearby date range, broader location).
- Across conversation turns, use the full conversation history to refine searches. If the user says "last year" and you already know the context, use that.
- You operate STRICTLY within this circle. Do not reference, infer, or search any other circle.
- After calling search_media, always provide a helpful natural-language summary of what you found.

## Filtering by people
You can filter photos by the people who appear in them using the \`people\` parameter (an array of person names) and \`peopleMatch\` parameter.
- Use \`peopleMatch: "all"\` when the query asks for a photo containing ALL the listed people together (e.g. "Oscar and Pamela", "the whole family", "both of them", "with all of").
- Use \`peopleMatch: "any"\` when the query asks for photos containing ANY of the listed people (e.g. "Oscar or Pamela", "either one", "any of these people").
- When in doubt with multiple names, default to \`"all"\`.
- If a person name you searched for is not found in the circle, the filter is silently skipped — mention to the user that no matching person was found.

## Semantic search vs structured filters
- Use \`semanticQuery\` when the user describes a visual scene, mood, activity, or photo content — e.g. "sunset over the ocean", "birthday cake with candles", "kids laughing in the garden". This performs vector similarity search over AI-generated photo descriptions.
- Use structured filters (dates, places, people, tags, type, favorite, etc.) when the user specifies concrete metadata — e.g. "photos from last Christmas", "pictures taken in Costa Rica", "videos of Oscar".
- You can combine both in a single call: e.g. \`semanticQuery: "snowy mountain trail"\` plus \`capturedAt: { from: "2023-01-01", to: "2023-03-31" }\` to find snowy mountain trail photos taken in Q1 2023.
- When semanticQuery is used and the embedding feature is not configured, the search will silently fall back to filter-only mode.

## Date ranges
- \`from\` and \`to\` accept \`YYYY-MM-DD\`. Both bounds are INCLUSIVE of the whole day, so \`{ from: "2023-01-01", to: "2023-03-31" }\` covers all of March 31 — do not add a day to \`to\` to compensate.
- \`capturedAt\` is the date the photo was TAKEN, on the photographer's calendar. \`uploadedAt\` is when it was added to the library. Pick whichever the user actually asked about.`;

@Injectable()
export class SearchAgentService {
  private readonly logger = new Logger(SearchAgentService.name);

  constructor(
    private readonly aiSettings: MemoriaHubAiSettings,
    private readonly ai: AiService,
    private readonly searchService: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolve an array of person name strings to Person UUIDs within a circle.
   * Names are matched case-insensitively. Unknown names are silently dropped.
   */
  private async resolvePersonNames(names: string[], circleId: string): Promise<string[]> {
    const trimmedNames = names
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim());
    if (trimmedNames.length === 0) return [];

    const persons = await this.prisma.person.findMany({
      where: {
        circleId,
        deletedAt: null,
        name: { in: trimmedNames, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });

    return persons.map((p) => p.id);
  }

  /**
   * If the tool input contains `people` (array of name strings) and/or `peopleMatch`,
   * resolve names to IDs and rewrite the input to use `people: { ids, mode }`.
   */
  private async resolvePeopleFilter(
    toolInput: Record<string, unknown>,
    circleId: string,
  ): Promise<void> {
    const rawPeople = toolInput['people'];
    const rawMode = toolInput['peopleMatch'];

    delete toolInput['peopleMatch'];

    if (!Array.isArray(rawPeople) || rawPeople.length === 0) {
      delete toolInput['people'];
      return;
    }

    const names = rawPeople.filter((n): n is string => typeof n === 'string');
    const ids = await this.resolvePersonNames(names, circleId);

    if (ids.length === 0) {
      delete toolInput['people'];
      return;
    }

    const mode: 'all' | 'any' = rawMode === 'any' ? 'any' : 'all';
    toolInput['people'] = { ids, mode };
  }

  async *streamTurn(params: AgentTurnParams): AsyncGenerator<AgentSseEvent> {
    const { circleId, messages, userId, permissions } = params;

    // 1. The search selection (`ai.features.search`)
    const selection = await this.aiSettings.selection('search');
    if (!selection) {
      throw new BadRequestException(
        'AI search is not configured. An admin must configure the AI provider and model in AI Settings.',
      );
    }
    const { provider: providerKey, model } = selection;

    // 2. The caller's AI client (feature `search_agent`): the key is the platform's to resolve per call.
    const client = this.ai.forUser(userId, { feature: MEMORIAHUB_AI_FEATURES.searchAgent });

    // 3./4. Build the tool: the JSON Schema the model is told, as the platform's function tool.
    const searchMediaToolDef = buildSearchMediaToolDef();
    const searchMediaTool: AiFunctionTool = {
      type: 'function',
      name: searchMediaToolDef.name,
      description: searchMediaToolDef.description,
      parameters: z.fromJSONSchema(searchMediaToolDef.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      // The old providers never asked for strict function calling: an optional argument stays optional.
      strict: false,
    };

    // 5. Build message history from the passed-in messages array
    const chatMessages: ChatMessage[] = messages.map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    }));

    // 6. Multi-turn tool-calling loop
    const MAX_ROUNDS = 6;
    let round = 0;
    let continueLoop = true;

    while (continueLoop && round < MAX_ROUNDS) {
      round++;
      let accumulatedText = '';
      let didToolCall = false;

      const roundToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      const roundToolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> = [];

      const request: AiRequest = {
        provider: providerKey,
        model,
        instructions: SYSTEM_PROMPT,
        input: toInputItems(chatMessages),
        tools: [searchMediaTool],
        // One tool call per turn keeps the assistant + tool-result append valid.
        ...(providerKey === 'openai' ? { providerOptions: { openai: { parallel_tool_calls: false } } } : {}),
        ...(providerKey === 'anthropic' ? { maxOutputTokens: ANTHROPIC_CHAT_MAX_TOKENS } : {}),
      };

      // `openStream` settles the gates and the provider connection BEFORE the first event, so a
      // refusal (the kill switch, no key, a model that cannot call tools) is thrown here, ahead of
      // the first SSE frame, like the old provider's first-iteration error.
      for await (const event of streamTextAndCalls(await client.openStream(request))) {
        if ('text' in event) {
          accumulatedText += event.text;
          yield { event: 'token', data: { text: event.text } };
        } else if (event.call.name === 'search_media') {
          const call = event.call;
          const toolInput = call.input;

          await this.resolvePeopleFilter(toolInput, circleId);

          // Extract semanticQuery before passing filters — it is a top-level param,
          // not a registry filter key (buildWhereFromFields would reject it).
          const semanticQuery =
            typeof toolInput['semanticQuery'] === 'string' ? toolInput['semanticQuery'] : undefined;
          delete toolInput['semanticQuery'];

          yield { event: 'tool_call', data: { name: 'search_media', args: { ...toolInput, ...(semanticQuery ? { semanticQuery } : {}) } } };

          // Execute search — circleId ALWAYS from params, NEVER from model input
          const searchResult = await this.searchService.runSearch(
            userId,
            circleId,
            permissions,
            toolInput,
            undefined,
            semanticQuery,
          );

          yield { event: 'results', data: searchResult };

          roundToolCalls.push({ id: call.id, name: call.name, input: toolInput });
          roundToolResults.push({ toolCallId: call.id, toolName: call.name, result: searchResult });

          didToolCall = true;
        }
      }

      if (didToolCall) {
        chatMessages.push({
          role: 'assistant',
          content: accumulatedText,
          toolCalls: roundToolCalls,
        });

        for (const tr of roundToolResults) {
          chatMessages.push({
            role: 'tool',
            content: JSON.stringify(tr.result),
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
          });
        }
      }

      continueLoop = didToolCall;
    }

    if (round >= MAX_ROUNDS && continueLoop) {
      this.logger.warn(`SearchAgentService: hit MAX_ROUNDS (${MAX_ROUNDS}) limit, stopping loop`);
    }
  }
}
