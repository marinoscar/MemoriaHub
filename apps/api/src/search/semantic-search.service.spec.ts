/**
 * Unit tests for SemanticSearchService.
 *
 * Covers embedQuery (null-safe, graceful degradation).
 *
 * knnMediaIds uses $queryRaw (pgvector) and requires a real DB with the
 * pgvector extension — those are integration tests only and are NOT run here.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from '@marinoscar/platform-api/ai';
import { SemanticSearchService } from './semantic-search.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoriaHubAiSettings } from '../ai-port/memoriahub-ai-settings';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

/** A `vector(1536)`-sized embedding, the only size `media_item_embedding` holds. */
const vec1536 = (): number[] => Array.from({ length: 1536 }, (_, i) => i / 1536);

describe('SemanticSearchService', () => {
  let service: SemanticSearchService;
  let mockPrisma: MockPrismaService;
  let mockAiSettings: { selection: jest.Mock };
  let mockEmbed: jest.Mock;
  let mockForUser: jest.Mock;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockAiSettings = { selection: jest.fn() };
    mockEmbed = jest.fn();
    mockForUser = jest.fn().mockReturnValue({ embed: mockEmbed });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SemanticSearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MemoriaHubAiSettings, useValue: mockAiSettings },
        { provide: AiService, useValue: { forUser: mockForUser } },
      ],
    }).compile();

    service = module.get<SemanticSearchService>(SemanticSearchService);
  });

  // -------------------------------------------------------------------------
  // embedQuery — null when unconfigured
  // -------------------------------------------------------------------------

  describe('embedQuery — null when unconfigured', () => {
    it('returns null when no embedding selection is saved', async () => {
      mockAiSettings.selection.mockResolvedValue(null);

      const result = await service.embedQuery('find my sunset photos', 'user-1');

      expect(result).toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns null and does not throw when reading the selection throws', async () => {
      mockAiSettings.selection.mockRejectedValue(new Error('Settings DB error'));

      await expect(service.embedQuery('test query', 'user-1')).resolves.toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns null when the platform refuses the call (no key, kill switch, model not enabled)', async () => {
      mockAiSettings.selection.mockResolvedValue({ provider: 'openai', model: 'text-embedding-3-small' });
      mockEmbed.mockRejectedValue(new Error('No API key available'));

      await expect(service.embedQuery('test query', 'user-1')).resolves.toBeNull();
    });

    it('returns null when the model answers vectors the storage cannot hold (dimension guard)', async () => {
      mockAiSettings.selection.mockResolvedValue({ provider: 'openai', model: 'text-embedding-3-large' });
      mockEmbed.mockResolvedValue({ vectors: [Array.from({ length: 3072 }, () => 0.1)] });

      await expect(service.embedQuery('test query', 'user-1')).resolves.toBeNull();
    });

    it('returns null when the provider throws (e.g. API rate limit)', async () => {
      mockAiSettings.selection.mockResolvedValue({ provider: 'openai', model: 'text-embedding-3-small' });
      mockEmbed.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(service.embedQuery('test query', 'user-1')).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // embedQuery — returns vector on success
  // -------------------------------------------------------------------------

  describe('embedQuery — returns vector on success', () => {
    beforeEach(() => {
      mockAiSettings.selection.mockResolvedValue({ provider: 'openai', model: 'text-embedding-3-small' });
      mockEmbed.mockResolvedValue({ vectors: [vec1536()] });
    });

    it('returns the embedding vector from the platform AiService', async () => {
      const result = await service.embedQuery('family at the beach', 'user-1');

      expect(result).toEqual(vec1536());
    });

    it('reads the embedding selection once', async () => {
      await service.embedQuery('query text', 'user-1');

      expect(mockAiSettings.selection).toHaveBeenCalledTimes(1);
      expect(mockAiSettings.selection).toHaveBeenCalledWith('embedding');
    });

    it('calls the platform as the caller, under the semantic_embedding feature', async () => {
      await service.embedQuery('query text', 'user-1');

      expect(mockForUser).toHaveBeenCalledWith('user-1', { feature: 'semantic_embedding' });
    });

    it('embeds the text as-is with the saved provider and model', async () => {
      await service.embedQuery('  family at the beach  ', 'user-1');

      // SemanticSearchService passes the text as-is (trimming is done in SearchService)
      expect(mockEmbed).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'text-embedding-3-small',
        input: '  family at the beach  ',
      });
    });
  });

  // -------------------------------------------------------------------------
  // knnMediaIds — integration-only note
  // -------------------------------------------------------------------------

  describe('knnMediaIds', () => {
    /**
     * knnMediaIds uses $queryRaw with the pgvector <=> operator.
     * It cannot be unit-tested without a real PostgreSQL + pgvector database.
     *
     * Coverage for this method requires the integration test suite with the
     * pgvector CI database (see: tests/integration/).
     *
     * This placeholder asserts the method exists so TypeScript catches signature changes.
     */
    it('exposes knnMediaIds as a method on the service', () => {
      expect(typeof service.knnMediaIds).toBe('function');
    });
  });
});
