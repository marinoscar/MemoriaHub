/**
 * Unit tests for SearchAgentService.
 *
 * Key invariants under test:
 * 1. circleId is always taken from params, never from model output
 * 2. ForbiddenException from searchService propagates to the caller
 * 3. Missing AI config throws BadRequestException before any provider call
 * 4. The loop continues after a tool call and produces token events in round 2
 * 5. resolvePeopleFilter rewrites people names to IDs and removes peopleMatch
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import type { MemoriahubAiStreamEvent } from '../../ports/index.js';
import { SearchAgentService, AgentSseEvent } from './search-agent.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(gen: AsyncGenerator<AgentSseEvent>): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Build a minimal messages array with a single user message */
function makeMessages(userContent = 'show beach photos') {
  return [{ role: 'user' as const, content: userContent }];
}

// ---------------------------------------------------------------------------
// Mock chat generators that match the two-round loop:
//   Round 1 → tool_call + done (loop continues because didToolCall=true)
//   Round 2 → text narration + done (loop stops because didToolCall=false)
// ---------------------------------------------------------------------------

/**
 * Returns a factory that, on the first call, emits a tool_call then done,
 * and on the second call emits text narration then done.
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

/**
 * The scripted events below read like the old provider's chat stream (`text`, `tool_call`,
 * `done`); the agent reads the port's (`text`, `tool_call` with its arguments as a JSON string,
 * `done`), so the mocked `openStream` maps one onto the other.
 */
async function* toPortStream(events: AsyncIterable<any>): AsyncGenerator<MemoriahubAiStreamEvent> {
  for await (const e of events) {
    if (e.type === 'text') {
      yield { type: 'text', text: e.text };
    } else if (e.type === 'tool_call') {
      yield { type: 'tool_call', id: e.id, name: e.name, arguments: JSON.stringify(e.input) };
    } else if (e.type === 'done') {
      yield { type: 'done' };
    }
  }
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
    selection: jest.Mock;
  };
  /** `get()` answers the scripted chat source: `{ chat(request) }`. */
  let mockRegistry: { get: jest.Mock };
  let mockOpenStream: jest.Mock;
  let mockForUser: jest.Mock;
  let mockSearchService: { runSearch: jest.Mock };
  let mockPrisma: { person: { findMany: jest.Mock } };

  beforeEach(() => {
    mockAiSettings = {
      getSettings: jest.fn(),
      resolveCredentials: jest.fn(),
      // `selection('search')` answers the saved provider/model, or null when half-filled.
      selection: jest.fn(async () => {
        const chosen = (await mockAiSettings.getSettings())?.features?.search;
        return chosen?.provider && chosen?.model ? chosen : null;
      }),
    };
    mockRegistry = {
      get: jest.fn(),
    };
    mockOpenStream = jest.fn(async (request: unknown) => toPortStream(mockRegistry.get().chat(request)));
    mockForUser = jest.fn().mockReturnValue({ openStream: mockOpenStream });
    mockSearchService = {
      runSearch: jest.fn(),
    };
    mockPrisma = {
      person: {
        findMany: jest.fn(),
      },
    };

    // The settings port: `getSettings()` answers the `ai` namespace (`features.search`).
    const settings = { readSystem: async () => ({ value: await mockAiSettings.getSettings(), version: 1 }) };

    service = new SearchAgentService(
      settings as never,
      { forUser: mockForUser } as never,
      mockSearchService as never,
      mockPrisma as never,
    );

  });

  // ---------------------------------------------------------------------------
  describe('circleId always comes from params, not model input', () => {
    it('calls searchService.runSearch with circleId from params', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory({ circleId: 'model-injected', tag: 'beach' });
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const gen = service.streamTurn({
        circleId: 'circle-from-params',
        messages: makeMessages('show beach photos'),
        userId: 'user-test',
        permissions: ['circles:read'],
      });

      await collectEvents(gen);

      // runSearch signature: (userId, circleId, permissions, filters, paging?, semanticQuery?)
      // The agent passes circleId from params (never from model output), paging as undefined,
      // and semanticQuery extracted from the tool input (undefined when not present).
      expect(mockSearchService.runSearch).toHaveBeenCalledWith(
        'user-test',
        'circle-from-params', // from params, never from model output ('model-injected')
        ['circles:read'],
        expect.any(Object), // filters/toolInput
        undefined,           // paging — agent does not override pagination
        undefined,           // semanticQuery — not present in this tool input
      );
    });

    it('emits tool_call, results, token events across the two rounds', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory();
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('show beach photos'),
        userId: 'user-test',
        permissions: [],
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
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory({ tag: 'beach' });
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('show beach photos'),
        userId: 'user-test',
        permissions: [],
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
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory({ tag: 'beach' }, 'Found some beach photos.');
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockResolvedValue({
        items: [{ id: 'media-1' }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('show beach photos'),
        userId: 'user-test',
        permissions: [],
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
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });
      const chatFactory = makeTwoRoundChatFactory();
      mockRegistry.get.mockReturnValue({ chat: chatFactory });
      mockSearchService.runSearch.mockRejectedValue(
        new ForbiddenException('not a member'),
      );

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('show beach photos'),
        userId: 'user-non-member',
        permissions: [],
      });

      await expect(collectEvents(gen)).rejects.toThrow(ForbiddenException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('missing AI configuration', () => {
    it('throws BadRequestException before any provider call when provider is null', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: null, model: null } },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('show beach photos'),
        userId: 'user-test',
        permissions: [],
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when model is missing', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: null } },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('anything'),
        userId: 'user-test',
        permissions: [],
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when provider is an empty string', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: '', model: '' } },
      });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('anything'),
        userId: 'user-test',
        permissions: [],
      });

      await expect(collectEvents(gen)).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('multi-turn history', () => {
    it('passes all prior messages to the provider in order', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });

      const capturedArgs: unknown[] = [];
      async function* textOnlyChat(...args: unknown[]) {
        capturedArgs.push(args);
        yield { type: 'text' as const, text: 'ok' };
        yield { type: 'done' as const, stopReason: 'end_turn' };
      }
      mockRegistry.get.mockReturnValue({ chat: (...a: unknown[]) => textOnlyChat(...a) });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'second question' },
        ],
        userId: 'user-test',
        permissions: [],
      });

      await collectEvents(gen);

      // The stream was opened once, as the caller and under the search_agent feature, and the
      // request carried all 3 turns in order, the instructions and the search_media tool.
      expect(mockForUser).toHaveBeenCalledWith('user-test', { feature: 'search_agent' });
      expect(capturedArgs.length).toBeGreaterThan(0);
      const request = (capturedArgs[0] as any[])[0];
      expect(request).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
      expect(request.tools.map((t: { name: string }) => t.name)).toEqual(['search_media']);
      expect(request.input.map((i: { role: string }) => i.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('populates finalText with narration from a text-only response (no tool call)', async () => {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'sk-test' });

      async function* textOnlyChat() {
        yield { type: 'text' as const, text: 'Hello world' };
        yield { type: 'done' as const, stopReason: 'end_turn' };
      }
      mockRegistry.get.mockReturnValue({ chat: () => textOnlyChat() });

      const gen = service.streamTurn({
        circleId: 'circle-1',
        messages: makeMessages('tell me something'),
        userId: 'user-test',
        permissions: [],
      });

      const events = await collectEvents(gen);
      const tokenEvents = events.filter((e) => e.event === 'token') as Array<
        Extract<AgentSseEvent, { event: 'token' }>
      >;

      expect(tokenEvents.map((e) => e.data.text).join('')).toBe('Hello world');
    });
  });

  // ---------------------------------------------------------------------------
  describe('resolvePeopleFilter — name-to-ID resolution via tool call rewrite', () => {
    const OSCAR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const PAMELA_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const CIRCLE_ID = 'circle-from-params';

    function setupForPeopleTest(toolInput: Record<string, unknown>) {
      mockAiSettings.getSettings.mockResolvedValue({
        features: { search: { provider: 'openai', model: 'gpt-4o' } },
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('show photos with Oscar and Pamela'),
        userId: 'user-test',
        permissions: [],
      });

      const events = await collectEvents(gen);

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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('Oscar photos'),
        userId: 'user-test',
        permissions: [],
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('find oscar'),
        userId: 'user-test',
        permissions: [],
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('Oscar or Pamela'),
        userId: 'user-test',
        permissions: [],
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('Oscar and Unknown Person'),
        userId: 'user-test',
        permissions: [],
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('Nobody at the beach'),
        userId: 'user-test',
        permissions: [],
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

      const gen = service.streamTurn({
        circleId: CIRCLE_ID,
        messages: makeMessages('Oscar photos'),
        userId: 'user-test',
        permissions: [],
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
