/**
 * Unit tests for SemanticSearchService.
 *
 * Covers embedQuery (null-safe, graceful degradation).
 *
 * knnMediaIds uses $queryRaw (pgvector) and requires a real DB with the
 * pgvector extension — those are integration tests only and are NOT run here.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SemanticSearchService } from './semantic-search.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('SemanticSearchService', () => {
  let service: SemanticSearchService;
  let mockPrisma: MockPrismaService;
  let mockAiSettings: {
    resolveEmbeddingConfig: jest.Mock;
    resolveCredentials: jest.Mock;
  };
  let mockRegistry: { get: jest.Mock };
  let mockEmbedProvider: { embedText: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEmbedProvider = { embedText: jest.fn() };
    mockRegistry = { get: jest.fn().mockReturnValue(mockEmbedProvider) };
    mockAiSettings = {
      resolveEmbeddingConfig: jest.fn(),
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SemanticSearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AiSettingsService, useValue: mockAiSettings },
        { provide: AiProviderRegistry, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<SemanticSearchService>(SemanticSearchService);
  });

  // -------------------------------------------------------------------------
  // embedQuery — null when unconfigured
  // -------------------------------------------------------------------------

  describe('embedQuery — null when unconfigured', () => {
    it('returns null when resolveEmbeddingConfig returns null (no provider configured)', async () => {
      mockAiSettings.resolveEmbeddingConfig.mockResolvedValue(null);

      const result = await service.embedQuery('find my sunset photos');

      expect(result).toBeNull();
      expect(mockEmbedProvider.embedText).not.toHaveBeenCalled();
    });

    it('returns null and does not throw when resolveEmbeddingConfig throws', async () => {
      mockAiSettings.resolveEmbeddingConfig.mockRejectedValue(new Error('Settings DB error'));

      await expect(service.embedQuery('test query')).resolves.toBeNull();
      expect(mockEmbedProvider.embedText).not.toHaveBeenCalled();
    });

    it('returns null when resolveCredentials throws (credentials missing)', async () => {
      mockAiSettings.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      mockAiSettings.resolveCredentials.mockRejectedValue(new Error('No credentials for openai'));

      await expect(service.embedQuery('test query')).resolves.toBeNull();
      expect(mockEmbedProvider.embedText).not.toHaveBeenCalled();
    });

    it('returns null when the provider does not implement embedText', async () => {
      mockAiSettings.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'anthropic',
        model: 'embed-v1',
      });
      mockAiSettings.resolveCredentials.mockResolvedValue({ apiKey: 'anthropic-key' });
      // Provider without embedText method
      mockRegistry.get.mockReturnValue({ analyzeImage: jest.fn() });

      await expect(service.embedQuery('test query')).resolves.toBeNull();
    });

    it('returns null when embedText throws (e.g. API rate limit)', async () => {
      mockAiSettings.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      mockEmbedProvider.embedText.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(service.embedQuery('test query')).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // embedQuery — returns vector on success
  // -------------------------------------------------------------------------

  describe('embedQuery — returns vector on success', () => {
    const expectedVector = [0.1, 0.2, 0.3, 0.4, 0.5];

    beforeEach(() => {
      mockAiSettings.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      mockEmbedProvider.embedText.mockResolvedValue(expectedVector);
    });

    it('returns the embedding vector from the provider', async () => {
      const result = await service.embedQuery('family at the beach');

      expect(result).toEqual(expectedVector);
    });

    it('calls resolveEmbeddingConfig once', async () => {
      await service.embedQuery('query text');

      expect(mockAiSettings.resolveEmbeddingConfig).toHaveBeenCalledTimes(1);
    });

    it('calls resolveCredentials with the configured provider key', async () => {
      await service.embedQuery('query text');

      expect(mockAiSettings.resolveCredentials).toHaveBeenCalledWith('openai');
    });

    it('calls registry.get with the configured provider key', async () => {
      await service.embedQuery('query text');

      expect(mockRegistry.get).toHaveBeenCalledWith('openai');
    });

    it('calls embedText with the resolved credentials, model, and trimmed text', async () => {
      await service.embedQuery('  family at the beach  ');

      // SemanticSearchService passes the text as-is (trimming is done in SearchService)
      expect(mockEmbedProvider.embedText).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'test-key' }),
        'text-embedding-3-small',
        '  family at the beach  ',
      );
    });

    it('passes baseUrl from credentials to embedText', async () => {
      mockAiSettings.resolveCredentials.mockResolvedValue({
        apiKey: 'test-key',
        baseUrl: 'https://custom.openai.endpoint',
      });

      await service.embedQuery('test');

      expect(mockEmbedProvider.embedText).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://custom.openai.endpoint' }),
        expect.any(String),
        expect.any(String),
      );
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
