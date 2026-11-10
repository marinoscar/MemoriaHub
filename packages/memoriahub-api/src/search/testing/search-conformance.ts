import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { SearchAgentService } from '../agent/search-agent.service.js';
import { buildWhereFromFields } from '../searchable-fields.registry.js';
import type { SearchService } from '../search.service.js';
import type { FakeSearchStore } from './fake-search-db.js';

// =============================================================================
// describeSearchSliceConformance (RETRO-J7, #618)
// =============================================================================
//
// The executable proof that the search slice behaves the same wherever it is hosted. The package runs
// it against its in-memory fakes; the web app runs it over its own port adapters
// (`apps/api/test/search/search-slice-conformance.spec.ts`); a bare host runs it over its own.
// Test-runner neutral: the caller hands over `describe`, `it` and `expect`.
//
//   scope        a caller who is not a member of the owner scope gets not-found, never results; every
//                query is bound to the scope and to the live (not trashed) rows;
//   filters      an unknown filter key is a 400; two filters that each emit an OR are AND-composed, never
//                one clobbering the other; `near` is a bounding box;
//   semantic     with no embedding model configured a `semanticQuery` falls back to the filters (no
//                model call); with one it embeds as the CALLER under the permanent feature id and ranks
//                by the KNN order;
//   agent        no search model configured is a 400 before any model call; the scope of every search the
//                model asks for is the request's, and a scope the model names is refused, never honoured.
//
// A section a host leaves out is skipped, never silently passed.
// =============================================================================

/**
 * The deterministic and semantic search sections.
 *
 * @stability experimental
 */
export interface SearchServiceUnderTest {
  /** The service. */
  service: SearchService;
  /** The in-memory store behind the database port. */
  store: FakeSearchStore;
  /** Declares an owner scope and its members. */
  seedScope(scopeId: string, members: Record<string, 'viewer' | 'editor' | 'admin'>): void | Promise<void>;
  /** Saves (or clears, with `null`) the `ai.features.embedding` model. */
  setEmbeddingSelection(selection: { provider: string; model: string } | null): void | Promise<void>;
  /** The AI calls made so far. */
  aiCalls(): Array<{ method: string; kind: string; userId?: string; feature: string }>;
}

/**
 * The agent section.
 *
 * @stability experimental
 */
export interface SearchAgentUnderTest {
  /** The service. */
  service: SearchAgentService;
  /** The in-memory store behind the database port. */
  store: FakeSearchStore;
  /** Declares an owner scope and its members. */
  seedScope(scopeId: string, members: Record<string, 'viewer' | 'editor' | 'admin'>): void | Promise<void>;
  /** Saves (or clears, with `null`) the `ai.features.search` model. */
  setSearchSelection(selection: { provider: string; model: string } | null): void | Promise<void>;
  /** Makes the model ask for one `search_media` call with these arguments. */
  scriptToolCall(args: Record<string, unknown>): void;
  /** The AI calls made so far. */
  aiCalls(): Array<{ method: string; kind: string; userId?: string; feature: string }>;
}

/**
 * What the kit runs against; a section left out is skipped.
 *
 * @stability experimental
 */
export interface SearchSliceUnderTest {
  /** The scope, filter and semantic sections. */
  search?: SearchServiceUnderTest;
  /** The agent section. */
  agent?: SearchAgentUnderTest;
}

/**
 * Options of {@link describeSearchSliceConformance}.
 *
 * @stability experimental
 */
export interface SearchSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh set of services; called before each rule so state never leaks between rules. */
  create(): SearchSliceUnderTest | Promise<SearchSliceUnderTest>;
}

const dto = (circleId: string, extra: Record<string, unknown> = {}) => ({
  circleId,
  filters: {},
  page: 1,
  pageSize: 20,
  sortBy: 'capturedAt',
  sortOrder: 'desc',
  ...extra,
});

/**
 * Runs the search slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeSearchSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: SearchSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`search slice conformance: ${options.name}`, () => {
    describe('scope', () => {
      it('a caller who is not a member of the scope gets not-found, never results', async () => {
        const { search } = await options.create();
        if (!search) return;
        await search.seedScope('lib-1', { member: 'viewer' });
        search.store.items.push({ id: 'm1', circleId: 'lib-1' });

        const error = await search.service.search(dto('lib-1') as never, 'stranger', []).catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(404);
        expect(search.store.wheres).toEqual([]);
      });

      it('binds every query to the scope and to the live rows', async () => {
        const { search } = await options.create();
        if (!search) return;
        await search.seedScope('lib-1', { member: 'viewer' });
        search.store.items.push({ id: 'm1', circleId: 'lib-1' }, { id: 'm2', circleId: 'lib-2' }, { id: 'm3', circleId: 'lib-1', deletedAt: new Date() });

        const result = await search.service.search(dto('lib-1') as never, 'member', []);

        expect(result.items.map((item) => item['id'])).toEqual(['m1']);
        expect(search.store.wheres[0]).toMatchObject({ circleId: 'lib-1', deletedAt: null });
      });
    });

    describe('filters', () => {
      it('an unknown filter key is a 400', async () => {
        const { search } = await options.create();
        if (!search) return;
        await search.seedScope('lib-1', { member: 'viewer' });

        const error = await search.service.search(dto('lib-1', { filters: { nope: 1 } }) as never, 'member', []).catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(400);
      });

      it('AND-composes two filters that each emit an OR, so neither clobbers the other', () => {
        const where = buildWhereFromFields('lib-1', { country: 'Costa Rica', location: 'Heredia' });

        const withOr = (where['AND'] as Array<Record<string, unknown>>).filter((clause) => 'OR' in clause);
        expect(withOr).toHaveLength(2);
      });

      it('`near` is a bounding box around the point', () => {
        const where = buildWhereFromFields('lib-1', { near: { lat: 10, lng: -84, radiusKm: 50 } });

        const box = (where['AND'] as Array<Record<string, any>>).find((clause) => 'takenLat' in clause)!;
        expect(box['takenLat'].gte).toBeLessThan(10);
        expect(box['takenLat'].lte).toBeGreaterThan(10);
        expect(box['takenLng'].gte).toBeLessThan(-84);
        expect(box['takenLng'].lte).toBeGreaterThan(-84);
      });
    });

    describe('semantic search', () => {
      it('falls back to the filters, with no model call, when no embedding model is configured', async () => {
        const { search } = await options.create();
        if (!search) return;
        await search.seedScope('lib-1', { member: 'viewer' });
        await search.setEmbeddingSelection(null);
        search.store.items.push({ id: 'm1', circleId: 'lib-1' });

        const result = await search.service.search(dto('lib-1', { semanticQuery: 'sunset at the beach' }) as never, 'member', []);

        expect(result.items).toHaveLength(1);
        expect(search.aiCalls()).toEqual([]);
        expect(search.store.knnQueries).toBe(0);
      });

      it('embeds as the caller under the semantic_embedding feature and ranks by the KNN order', async () => {
        const { search } = await options.create();
        if (!search) return;
        await search.seedScope('lib-1', { member: 'viewer' });
        await search.setEmbeddingSelection({ provider: 'openai', model: 'text-embedding-3-small' });
        search.store.items.push({ id: 'm1', circleId: 'lib-1' }, { id: 'm2', circleId: 'lib-1' });
        search.store.knn = [
          { id: 'm2', distance: 0.1 },
          { id: 'm1', distance: 0.4 },
        ];

        const result = await search.service.search(dto('lib-1', { semanticQuery: 'sunset at the beach' }) as never, 'member', []);

        expect(result.items.map((item) => item['id'])).toEqual(['m2', 'm1']);
        expect(search.aiCalls()).toEqual([{ method: 'embed', kind: 'user', userId: 'member', feature: 'semantic_embedding' }]);
      });
    });

    describe('agent', () => {
      const params = (circleId: string) => ({
        circleId,
        messages: [{ role: 'user' as const, content: 'show beach photos' }],
        userId: 'member',
        permissions: [] as string[],
      });

      it('is a 400 before any model call when no search model is configured', async () => {
        const { agent } = await options.create();
        if (!agent) return;
        await agent.seedScope('lib-1', { member: 'viewer' });
        await agent.setSearchSelection(null);

        const error = await (async () => {
          for await (const _event of agent.service.streamTurn(params('lib-1'))) void _event;
        })().catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(400);
        expect(agent.aiCalls()).toEqual([]);
      });

      it('searches the request scope', async () => {
        const { agent } = await options.create();
        if (!agent) return;
        await agent.seedScope('lib-1', { member: 'viewer' });
        await agent.setSearchSelection({ provider: 'openai', model: 'model-a' });
        agent.scriptToolCall({ tag: 'beach' });

        const events: string[] = [];
        for await (const event of agent.service.streamTurn(params('lib-1'))) events.push(event.event);

        expect(events).toContain('tool_call');
        expect(events).toContain('results');
        expect(agent.store.wheres.length).toBeGreaterThan(0);
        for (const where of agent.store.wheres) expect(where['circleId']).toBe('lib-1');
        expect(agent.aiCalls()[0]).toEqual({ method: 'openStream', kind: 'user', userId: 'member', feature: 'search_agent' });
      });

      it('never honours a scope the model names: the turn is refused and no other scope is queried', async () => {
        const { agent } = await options.create();
        if (!agent) return;
        await agent.seedScope('lib-1', { member: 'viewer' });
        await agent.setSearchSelection({ provider: 'openai', model: 'model-a' });
        agent.scriptToolCall({ circleId: 'lib-other', tag: 'beach' });

        const error = await (async () => {
          for await (const _event of agent.service.streamTurn(params('lib-1'))) void _event;
        })().catch((e: unknown) => e);

        expect((error as { getStatus?: () => number }).getStatus?.()).toBe(400);
        expect(agent.store.wheres.filter((where) => where['circleId'] !== 'lib-1')).toEqual([]);
      });
    });
  });
}
