import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { SearchConversation, SearchMessage } from '@prisma/client';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import { ChatMessage } from '../../ai/providers/ai-provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchService } from '../search.service';
import { buildSearchMediaToolDef } from './search-tool-schema';

export type AgentSseEvent =
  | { event: 'tool_call'; data: { name: string; args: Record<string, unknown> } }
  | { event: 'token'; data: { text: string } }
  | { event: 'results'; data: { items: unknown[]; meta: unknown } }
  | { event: 'done'; data: { messageId: string } };

export interface AgentAccumulator {
  finalText: string;
  toolCalls: unknown[];
  toolResults: unknown[];
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
- If a person name you searched for is not found in the circle, the filter is silently skipped — mention to the user that no matching person was found.`;

@Injectable()
export class SearchAgentService {
  private readonly logger = new Logger(SearchAgentService.name);

  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
    private readonly searchService: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolve an array of person name strings to Person UUIDs within a circle.
   * Names are matched case-insensitively. Unknown names are silently dropped.
   * Returns an empty array if none match.
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
   * Unknown names are silently ignored; if none resolve, the filter is omitted entirely.
   */
  private async resolvePeopleFilter(
    toolInput: Record<string, unknown>,
    circleId: string,
  ): Promise<void> {
    const rawPeople = toolInput['people'];
    const rawMode = toolInput['peopleMatch'];

    // Clean up agent-specific params regardless
    delete toolInput['peopleMatch'];

    if (!Array.isArray(rawPeople) || rawPeople.length === 0) {
      delete toolInput['people'];
      return;
    }

    const names = rawPeople.filter((n): n is string => typeof n === 'string');
    const ids = await this.resolvePersonNames(names, circleId);

    if (ids.length === 0) {
      // No names resolved — omit filter to avoid returning zero results due to a typo
      delete toolInput['people'];
      return;
    }

    const mode: 'all' | 'any' = rawMode === 'any' ? 'any' : 'all';
    toolInput['people'] = { ids, mode };
  }

  async *streamTurn(params: {
    conversation: SearchConversation & { messages: SearchMessage[] };
    userContent: string;
    userId: string;
    permissions: string[];
    accumulator: AgentAccumulator;
  }): AsyncGenerator<AgentSseEvent> {
    const { conversation, userContent, userId, permissions, accumulator } = params;

    // 1. Load AI settings
    const settings = await this.aiSettings.getSettings();
    const providerKey = settings.features.search.provider;
    const model = settings.features.search.model;

    if (!providerKey || !model) {
      throw new BadRequestException(
        'AI search is not configured. An admin must configure the AI provider and model in AI Settings.',
      );
    }

    // 2. Resolve credentials
    const creds = await this.aiSettings.resolveCredentials(providerKey);

    // 3. Get provider
    const provider = this.registry.get(providerKey);

    // 4. Build tool def
    const searchMediaTool = buildSearchMediaToolDef();

    // 5. Build message history from existing conversation messages
    const messages: ChatMessage[] = conversation.messages.map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    }));

    // Append the new user message
    messages.push({ role: 'user', content: userContent });

    // 6. Multi-turn tool-calling loop
    // Hard cap to prevent infinite loops in case of pathological tool-call chains
    const MAX_ROUNDS = 6;
    let round = 0;
    let continueLoop = true;

    while (continueLoop && round < MAX_ROUNDS) {
      round++;
      let accumulatedText = '';
      // Track whether any tool was called in this round — used for loop continuation
      let didToolCall = false;

      // Collect all tool calls in this round so we can attach them to a single
      // assistant message (required by OpenAI: every tool result must be preceded
      // by an assistant message with a matching tool_calls entry).
      const roundToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      const roundToolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> = [];

      for await (const event of provider.chat(creds, {
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: [searchMediaTool],
      })) {
        if (event.type === 'text') {
          accumulatedText += event.text;
          yield { event: 'token', data: { text: event.text } };
        } else if (event.type === 'tool_call' && event.name === 'search_media') {
          const toolInput = event.input as Record<string, unknown>;

          // Resolve people names → IDs before executing the search.
          // This rewrites toolInput in place: `people` (array of names) + `peopleMatch`
          // become `people: { ids, mode }` that the registry's buildWhere understands.
          await this.resolvePeopleFilter(toolInput, conversation.circleId);

          // Emit tool_call SSE event
          yield { event: 'tool_call', data: { name: 'search_media', args: toolInput } };

          // Execute search — circleId ALWAYS from conversation, NEVER from model input
          const searchResult = await this.searchService.runSearch(
            userId,
            conversation.circleId,
            permissions,
            toolInput,
          );

          // Emit results SSE event
          yield { event: 'results', data: searchResult };

          // Track in accumulator and for this round's message construction
          accumulator.toolCalls.push({ id: event.id, name: event.name, input: toolInput });
          accumulator.toolResults.push({ toolCallId: event.id, result: searchResult });
          roundToolCalls.push({ id: event.id, name: event.name, input: toolInput });
          roundToolResults.push({ toolCallId: event.id, toolName: event.name, result: searchResult });

          didToolCall = true;
        } else if (event.type === 'done') {
          accumulator.finalText += accumulatedText;
          // Always break out of the for-await after done
          break;
        }
      }

      // After the streaming turn ends, append a single assistant message with
      // all structured tool calls (required by OpenAI for tool round-trips).
      if (didToolCall) {
        messages.push({
          role: 'assistant',
          content: accumulatedText,
          toolCalls: roundToolCalls,
        });

        // Append one tool result message per tool call
        for (const tr of roundToolResults) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(tr.result),
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
          });
        }
      }

      // Continue looping if and only if a tool was called this round.
      // Do NOT rely on stopReason — it differs between providers
      // ('tool_use' for Anthropic, 'tool_calls' for OpenAI).
      continueLoop = didToolCall;
    }

    if (round >= MAX_ROUNDS && continueLoop) {
      this.logger.warn(`SearchAgentService: hit MAX_ROUNDS (${MAX_ROUNDS}) limit, stopping loop`);
    }
  }
}
