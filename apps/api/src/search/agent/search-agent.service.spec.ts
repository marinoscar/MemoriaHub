/**
 * Unit tests for SearchAgentService.
 *
 * Key invariants under test:
 * 1. circleId is always taken from conversation.circleId, never from model output
 * 2. ForbiddenException from searchService propagates to the caller
 * 3. Missing AI config throws BadRequestException before any provider call
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { SearchAgentService, AgentAccumulator, AgentSseEvent } from './search-agent.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import { SearchService } from '../search.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(gen: AsyncGenerator<AgentSseEvent>): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeAccumulator(): AgentAccumulator {
  return { finalText: '', toolCalls: [], toolResults: [] };
}

/** Minimal conversation object as expected by streamTurn */
function makeConversation(circleId = 'circle-from-conversation') {
  return {
    id: 'conv-test-1',
    circleId,
    title: null,
    favorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    deletedAt: null,
    userId: 'user-1',
    messages: [] as Array<{
      id: string;
      conversationId: string;
      role: string;
      content: string;
      toolCallId: string | null;
      toolName: string | null;
      createdAt: Date;
    }>,
  };
}

// ---------------------------------------------------------------------------
// Mock chat generator — produces a simple tool_call then text then done
// ---------------------------------------------------------------------------
async function* mockChatGenerator() {
  yield { type: 'tool_call' as const, id: 'tc-1', name: 'search_media', input: { tag: 'beach' } };
  yield { type: 'text' as const, text: 'Found some photos.' };
  yield { type: 'done' as const, stopReason: 'end_turn' };
}

// Chat generator that returns done immediately (for missing config / forbidden tests)
async function* mockChatGeneratorEmpty() {
  yield { type: 'done' as const, stopReason: 'end_turn' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SearchAgentService', () => {
  let service: SearchAgentService;
  let mockAiSettings: {
    getSettings: jest.Mock;
    resolveCredentials: jest.Mock;
  };
  let mockRegistry: { get: jest.Mock };
  let mockSearchService: { runSearch: jest.Mock };

  beforeEach(async () => {
    mockAiSettings = {
      getSettings: jest.fn(),
      resolveCredentials: jest.fn(),
    };
    mockRegistry = {
      get: jest.fn(),
    };
    mockSearchService = {
      runSearch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchAgentService,
        { provide: AiSettingsService, useValue: mockAiSettings },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: SearchService, useValue: mockSearchService },
      ],
    }).compile();

    service = module.get<SearchAgentService>(SearchAgentService);
  });

  // ---------------------------------------------------------------------------
  describe('circleId always comes from conversation, not model input', () => {
    it('calls searchService.runSearch with conversation.circleId', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockRegistry.get.mockReturnValue({ chat: () => mockChatGenerator() });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const conversation = makeConversation('circle-from-conversation');
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show beach photos',
        userId: 'user-test',
        permissions: ['circles:read'],
        accumulator: makeAccumulator(),
      });

      await collectEvents(gen);

      expect(mockSearchService.runSearch).toHaveBeenCalledWith(
        'user-test',
        'circle-from-conversation', // from conversation, never from model output
        ['circles:read'],
        expect.any(Object), // tool inputs (e.g. { tag: 'beach' })
      );
    });

    it('emits a tool_call event and a token event during the turn', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockRegistry.get.mockReturnValue({ chat: () => mockChatGenerator() });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show beach photos',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      const events = await collectEvents(gen);
      const eventTypes = events.map((e) => e.event);

      expect(eventTypes).toContain('tool_call');
      expect(eventTypes).toContain('token');
      expect(eventTypes).toContain('results');
    });

    it('the tool_call event contains search_media name and tool args', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockRegistry.get.mockReturnValue({ chat: () => mockChatGenerator() });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show beach photos',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      const events = await collectEvents(gen);
      const toolCallEvent = events.find((e) => e.event === 'tool_call') as Extract<
        AgentSseEvent,
        { event: 'tool_call' }
      > | undefined;

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.data.name).toBe('search_media');
      expect(toolCallEvent!.data.args).toEqual({ tag: 'beach' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('ForbiddenException propagation', () => {
    it('rejects when searchService.runSearch throws ForbiddenException', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockRegistry.get.mockReturnValue({ chat: () => mockChatGenerator() });
      mockSearchService.runSearch.mockRejectedValue(
        new ForbiddenException('not a member'),
      );

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show beach photos',
        userId: 'user-non-member',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await expect(collectEvents(gen)).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('missing AI configuration', () => {
    it('throws BadRequestException before any provider call when provider is null', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: null, model: null } },
        conversations: {},
      });

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show beach photos',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when model is missing', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: null } },
        conversations: {},
      });

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'anything',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when provider is an empty string', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: '', model: '' } },
        conversations: {},
      });

      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'anything',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('accumulator population', () => {
    it('populates accumulator.toolCalls after a tool call', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockRegistry.get.mockReturnValue({ chat: () => mockChatGenerator() });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const accumulator = makeAccumulator();
      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'find beach photos',
        userId: 'user-test',
        permissions: [],
        accumulator,
      });

      await collectEvents(gen);

      expect(accumulator.toolCalls).toHaveLength(1);
      expect((accumulator.toolCalls[0] as any).name).toBe('search_media');
    });

    it('populates accumulator.finalText after text events', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });

      // Provider that only returns text then done
      async function* textOnlyChat() {
        yield { type: 'text' as const, text: 'Hello world' };
        yield { type: 'done' as const, stopReason: 'end_turn' };
      }
      mockRegistry.get.mockReturnValue({ chat: () => textOnlyChat() });

      const accumulator = makeAccumulator();
      const conversation = makeConversation();
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'tell me something',
        userId: 'user-test',
        permissions: [],
        accumulator,
      });

      await collectEvents(gen);

      expect(accumulator.finalText).toBe('Hello world');
    });
  });
});
