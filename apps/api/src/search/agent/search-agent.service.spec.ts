/**
 * Unit tests for SearchAgentService.
 *
 * Key invariants under test:
 * 1. circleId is always taken from conversation.circleId, never from model output
 * 2. ForbiddenException from searchService propagates to the caller
 * 3. Missing AI config throws BadRequestException before any provider call
 * 4. The loop continues after a tool call and produces token events in round 2
 * 5. accumulator.finalText captures the narration from the second round
 * 6. resolvePeopleFilter rewrites people names to IDs and removes peopleMatch
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { SearchAgentService, AgentAccumulator, AgentSseEvent } from './search-agent.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import { SearchService } from '../search.service';
import { PrismaService } from '../../prisma/prisma.service';

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
// Mock chat generators that match the two-round loop:
//   Round 1 → tool_call + done (loop continues because didToolCall=true)
//   Round 2 → text narration + done (loop stops because didToolCall=false)
// ---------------------------------------------------------------------------

/**
 * Returns a factory that, on the first call, emits a tool_call then done,
 * and on the second call emits text narration then done.
 * This mirrors real provider behaviour where the model first calls a tool
 * and then narrates the results in a separate turn.
 */
function makeTwoRoundChatFactory(
  toolInput: Record<string, unknown> = { tag: 'beach' },
  narration = 'Found some photos.',
): () => AsyncIterable<unknown> {
  let callCount = 0;
  return function () {
    callCount++;
    if (callCount === 1) {
      return (async function* () {
        yield { type: 'tool_call' as const, id: 'tc-1', name: 'search_media', input: toolInput };
        yield { type: 'done' as const, stopReason: 'tool_calls' };
      })();
    }
    // Round 2: model narrates the results
    return (async function* () {
      yield { type: 'text' as const, text: narration };
      yield { type: 'done' as const, stopReason: 'end_turn' };
    })();
  };
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
  let mockPrisma: { person: { findMany: jest.Mock } };

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
    mockPrisma = {
      person: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchAgentService,
        { provide: AiSettingsService, useValue: mockAiSettings },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: SearchService, useValue: mockSearchService },
        { provide: PrismaService, useValue: mockPrisma },
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
      const chatFactory = makeTwoRoundChatFactory({ circleId: 'model-injected', tag: 'beach' });
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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

    it('emits tool_call, results, token events across the two rounds', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory();
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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

      // Round 1 emits tool_call + results; round 2 emits token
      expect(eventTypes).toContain('tool_call');
      expect(eventTypes).toContain('results');
      expect(eventTypes).toContain('token');
    });

    it('the tool_call event contains search_media name and tool args', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory({ tag: 'beach' });
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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

    it('token events appear after the tool results (second round narration)', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory({ tag: 'beach' }, 'Found some beach photos.');
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockResolvedValue({
        items: [{ id: 'media-1' }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
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
      const resultsIdx = events.findIndex((e) => e.event === 'results');
      const tokenIdx = events.findIndex((e) => e.event === 'token');

      // Token (narration) must come AFTER results
      expect(resultsIdx).toBeGreaterThanOrEqual(0);
      expect(tokenIdx).toBeGreaterThan(resultsIdx);
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
      const chatFactory = makeTwoRoundChatFactory();
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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
      const chatFactory = makeTwoRoundChatFactory();
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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

    it('populates accumulator.finalText with narration from the second round', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });

      const chatFactory = makeTwoRoundChatFactory({ tag: 'beach' }, 'Found 5 beach photos.');
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
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

      expect(accumulator.finalText).toBe('Found 5 beach photos.');
    });

    it('populates accumulator.finalText after text-only response (no tool call)', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });

      // Provider that only returns text then done (no tool call round)
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

  // ---------------------------------------------------------------------------
  describe('resolvePeopleFilter — name-to-ID resolution via tool call rewrite', () => {
    const OSCAR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const PAMELA_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const CIRCLE_ID = 'circle-from-conversation';

    function setupForPeopleTest(toolInput: Record<string, unknown>) {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
        conversations: {},
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const chatFactory = makeTwoRoundChatFactory(toolInput);
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
    }

    it('rewrites people names to IDs and removes peopleMatch from tool input', async () => {
      setupForPeopleTest({ people: ['Oscar', 'Pamela'], peopleMatch: 'all' });

      mockPrisma.person.findMany.mockResolvedValue([
        { id: OSCAR_ID, name: 'Oscar' },
        { id: PAMELA_ID, name: 'Pamela' },
      ]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'show photos with Oscar and Pamela',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      const events = await collectEvents(gen);

      // The tool_call event should show the rewritten input (names → ids)
      const toolCallEvent = events.find((e) => e.event === 'tool_call') as Extract<
        AgentSseEvent,
        { event: 'tool_call' }
      > | undefined;

      expect(toolCallEvent).toBeDefined();
      const args = toolCallEvent!.data.args as any;

      // people should now be the resolved object {ids, mode}
      expect(args.people).toEqual({ ids: [OSCAR_ID, PAMELA_ID], mode: 'all' });
      // peopleMatch should be stripped
      expect(args.peopleMatch).toBeUndefined();
    });

    it('passes circleId to prisma.person.findMany for circle-scoped resolution', async () => {
      setupForPeopleTest({ people: ['Oscar'], peopleMatch: 'all' });

      mockPrisma.person.findMany.mockResolvedValue([{ id: OSCAR_ID, name: 'Oscar' }]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'Oscar photos',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await collectEvents(gen);

      expect(mockPrisma.person.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_ID,
            deletedAt: null,
          }),
        }),
      );
    });

    it('performs case-insensitive lookup (mode: insensitive)', async () => {
      setupForPeopleTest({ people: ['oscar'], peopleMatch: 'all' });

      mockPrisma.person.findMany.mockResolvedValue([{ id: OSCAR_ID, name: 'Oscar' }]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'find oscar',
        userId: 'user-test',
        permissions: [],
        accumulator: makeAccumulator(),
      });

      await collectEvents(gen);

      expect(mockPrisma.person.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            name: expect.objectContaining({ mode: 'insensitive' }),
          }),
        }),
      );
    });

    it('sets mode to "any" when peopleMatch is "any"', async () => {
      setupForPeopleTest({ people: ['Oscar', 'Pamela'], peopleMatch: 'any' });

      mockPrisma.person.findMany.mockResolvedValue([
        { id: OSCAR_ID, name: 'Oscar' },
        { id: PAMELA_ID, name: 'Pamela' },
      ]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'Oscar or Pamela',
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
      const args = toolCallEvent!.data.args as any;
      expect(args.people.mode).toBe('any');
    });

    it('drops unknown names and still resolves the known ones', async () => {
      setupForPeopleTest({ people: ['Oscar', 'Unknown Person'], peopleMatch: 'all' });

      // Only Oscar found, "Unknown Person" not in DB
      mockPrisma.person.findMany.mockResolvedValue([{ id: OSCAR_ID, name: 'Oscar' }]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'Oscar and Unknown Person',
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
      const args = toolCallEvent!.data.args as any;
      expect(args.people).toEqual({ ids: [OSCAR_ID], mode: 'all' });
    });

    it('omits the people filter entirely when no names resolve', async () => {
      setupForPeopleTest({ people: ['Nobody'], peopleMatch: 'all', tag: 'beach' });

      // Nobody found in DB
      mockPrisma.person.findMany.mockResolvedValue([]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'Nobody at the beach',
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
      const args = toolCallEvent!.data.args as any;
      // people filter should be removed
      expect(args.people).toBeUndefined();
      // other filters should still be present
      expect(args.tag).toBe('beach');
    });

    it('removes people key when the people input is not an array', async () => {
      // Model could send an unexpected shape
      setupForPeopleTest({ people: 'Oscar', peopleMatch: 'all' });

      // findMany should not even be called (since it's not an array)
      mockPrisma.person.findMany.mockResolvedValue([]);

      const conversation = makeConversation(CIRCLE_ID);
      const gen = service.streamTurn({
        conversation: conversation as any,
        userContent: 'Oscar photos',
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
      const args = toolCallEvent!.data.args as any;
      expect(args.people).toBeUndefined();
      expect(args.peopleMatch).toBeUndefined();
    });
  });
});
