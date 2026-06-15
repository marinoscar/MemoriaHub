import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { SearchConversation, SearchMessage } from '@prisma/client';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import { ChatMessage } from '../../ai/providers/ai-provider.interface';
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
- After calling search_media, always provide a helpful natural-language summary of what you found.`;

@Injectable()
export class SearchAgentService {
  private readonly logger = new Logger(SearchAgentService.name);

  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
    private readonly searchService: SearchService,
  ) {}

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
    let continueLoop = true;
    while (continueLoop) {
      let accumulatedText = '';
      let shouldContinue = false;

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

          // Track in accumulator
          accumulator.toolCalls.push({ id: event.id, name: event.name, input: toolInput });
          accumulator.toolResults.push({ toolCallId: event.id, result: searchResult });

          // Append assistant message with any text accumulated so far in this round
          messages.push({
            role: 'assistant',
            content:
              accumulatedText ||
              `[Calling search_media with ${JSON.stringify(toolInput)}]`,
          });

          // Append tool result message so the model can see the outcome
          messages.push({
            role: 'tool',
            content: JSON.stringify(searchResult),
            toolCallId: event.id,
            toolName: event.name,
          });

          accumulatedText = '';
        } else if (event.type === 'done') {
          accumulator.finalText += accumulatedText;
          if (event.stopReason === 'tool_use') {
            // Model wants to continue after tool results — loop again
            shouldContinue = true;
          } else {
            shouldContinue = false;
          }
          // Always break out of the for-await after done
          break;
        }
      }

      continueLoop = shouldContinue;
    }
  }
}
