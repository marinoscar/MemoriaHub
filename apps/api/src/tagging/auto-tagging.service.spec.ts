/**
 * Unit tests for AutoTaggingService.
 *
 * Tests the 9-step pipeline: load media item, skip gates, status upserts,
 * config resolution, provider call, label validation, tag upsert, and
 * markFailed paths.
 */

// Stub sharp which is a native module not installed locally
jest.mock('sharp', () => {
  const mockPipeline = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue({
      data: Buffer.from('processed-image'),
      info: { width: 800, height: 600 },
    }),
  };
  return jest.fn().mockReturnValue(mockPipeline);
});

// Stub image-mime.util so tests control what detectImageMime returns
jest.mock('./image-mime.util', () => ({
  detectImageMime: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { AutoTaggingService } from './auto-tagging.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  MediaTagStatusType,
  MediaType,
} from '@prisma/client';
import { detectImageMime } from './image-mime.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'auto_tagging',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 20,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  type: MediaType;
  deletedAt: Date | null;
  addedById: string;
  storageObject: { storageKey: string } | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MediaType.photo,
    deletedAt: null,
    addedById: 'user-1',
    storageObject: { storageKey: 'images/photo.jpg' },
    ...overrides,
  };
}

function makeReadable(content: Buffer = Buffer.from('fake-image')): Readable {
  return Readable.from([content]);
}

function makeSystemSettings(provider: string | null = 'openai', model: string | null = 'gpt-4o') {
  return {
    key: 'global',
    value: {
      ai: {
        features: {
          tagging: { provider, model },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoTaggingService', () => {
  let service: AutoTaggingService;
  let mockPrisma: MockPrismaService;
  let mockAiSettingsService: { resolveCredentials: jest.Mock; resolveEmbeddingConfig: jest.Mock };
  let mockRegistry: { get: jest.Mock };
  let mockProvider: { analyzeImage: jest.Mock };
  let mockStorageProvider: { download: jest.Mock };
  let mockDetectImageMime: jest.Mock;
  let mockEnrichmentJobService: { recordModel: jest.Mock };
  let mockAiProviderForEmbedding: { embedText: jest.Mock };

  beforeEach(async () => {
    (jest.requireMock('sharp') as jest.Mock).mockClear();

    // Reset sharp mock to the happy-path pipeline (width: 800)
    const happyPipeline = {
      rotate: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue({
        data: Buffer.from('processed-image'),
        info: { width: 800, height: 600 },
      }),
    };
    (jest.requireMock('sharp') as jest.Mock).mockReturnValue(happyPipeline);

    mockDetectImageMime = detectImageMime as jest.Mock;
    mockDetectImageMime.mockReset();

    mockPrisma = createMockPrismaService();
    mockProvider = { analyzeImage: jest.fn() };
    mockAiProviderForEmbedding = { embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) };
    // By default, registry.get returns the main tagging provider.
    // Tests that need the embedding provider can override mockRegistry.get.
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockAiSettingsService = {
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }),
      resolveEmbeddingConfig: jest.fn().mockResolvedValue(null),
    };
    mockStorageProvider = {
      download: jest.fn().mockResolvedValue(makeReadable()),
    };
    mockEnrichmentJobService = { recordModel: jest.fn().mockResolvedValue(undefined) };

    // Default system settings: tagging configured
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
      makeSystemSettings(),
    );

    // Default media item
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
      makeMediaItem(),
    );

    // Default tag labels (enabled vocab)
    (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
      { name: 'Beach' },
      { name: 'Sunset' },
      { name: 'Mountain' },
    ]);

    // Default tag upsert
    (mockPrisma.tag.upsert as jest.Mock).mockResolvedValue({ id: 'tag-1' });
    (mockPrisma.mediaTag.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});

    // Default face.findMany — no faces with assigned persons (no people names)
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

    // Default $executeRaw — embedding upsert
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    // $transaction executes the callback with mockPrisma as the tx
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrisma);
      }
      return arg;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoTaggingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AiSettingsService, useValue: mockAiSettingsService },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<AutoTaggingService>(AutoTaggingService);
  });

  // -------------------------------------------------------------------------
  // Happy path: valid labels get upserted; invalid labels are dropped
  // -------------------------------------------------------------------------

  describe('happy path: label filtering and upsert', () => {
    it('upserts only vocabulary-matched labels; drops unrecognised items', async () => {
      // analyzeImage returns Beach (valid), Sunset (valid), Nonexistent Label (invalid)
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach', 'Sunset', 'Nonexistent Label'], caption: 'A beach scene.', description: 'Sun and water.' }),
      );

      await service.processMediaItem(makeJob());

      // tag.upsert must be called exactly twice (Beach and Sunset only)
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
      const tagNames = (mockPrisma.tag.upsert as jest.Mock).mock.calls.map(
        (c: any[]) => c[0].create.name,
      );
      expect(tagNames).toContain('Beach');
      expect(tagNames).toContain('Sunset');
      expect(tagNames).not.toContain('Nonexistent Label');
    });

    it('upserts a MediaTag row for each validated label', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach', 'Sunset'], caption: 'A beach.', description: 'Waves.' }),
      );

      (mockPrisma.tag.upsert as jest.Mock)
        .mockResolvedValueOnce({ id: 'tag-beach' })
        .mockResolvedValueOnce({ id: 'tag-sunset' });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledTimes(2);
    });

    it('sets MediaTagStatus to processed with correct tagCount, providerKey, and modelVersion', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach', 'Sunset'], caption: 'A beach.', description: 'Waves.' }),
      );

      await service.processMediaItem(makeJob());

      // Find the final status upsert call
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
      expect(finalUpsert.create.tagCount).toBe(2);
      expect(finalUpsert.create.providerKey).toBe('openai');
      expect(finalUpsert.create.modelVersion).toBe('gpt-4o');
      expect(finalUpsert.create.processedAt).toBeInstanceOf(Date);
    });

    it('sets Tag.addedById to the media item addedById', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      const tagUpsertCall = (mockPrisma.tag.upsert as jest.Mock).mock.calls[0][0];
      expect(tagUpsertCall.create.addedById).toBe('user-1');
    });

    it('sets Tag.circleId to the media item circleId', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      const tagUpsertCall = (mockPrisma.tag.upsert as jest.Mock).mock.calls[0][0];
      expect(tagUpsertCall.create.circleId).toBe('circle-1');
    });

    it('deduplicates identical labels returned by the provider', async () => {
      // Provider returns Beach twice
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach', 'Beach', 'Sunset'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      // Only 2 unique labels: Beach, Sunset
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('normalizes label case to match the original TagLabel name', async () => {
      // Provider returns lowercase variant
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['beach', 'sunset'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      const tagNames = (mockPrisma.tag.upsert as jest.Mock).mock.calls.map(
        (c: any[]) => c[0].create.name,
      );
      // Should be stored with original capitalisation from TagLabel vocab
      expect(tagNames).toContain('Beach');
      expect(tagNames).toContain('Sunset');
    });
  });

  // -------------------------------------------------------------------------
  // Robust JSON parse
  // -------------------------------------------------------------------------

  describe('parseAnalysisResult: robust JSON extraction', () => {
    it('parses response wrapped in triple-backtick json fences', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        '```json\n{"tags":["Beach","Sunset"],"caption":"A beach.","description":"Sand and waves."}\n```',
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('parses response with leading prose before the JSON object', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        'Here is my analysis: {"tags":["Beach","Mountain"],"caption":"Beach and mountain.","description":"Rocks and waves."}',
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('returns zero tags and parseOk=false when response is not parseable JSON', async () => {
      mockProvider.analyzeImage.mockResolvedValue('I cannot identify any labels.');

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
      // Status should still be processed with tagCount=0
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
      expect(finalUpsert.create.tagCount).toBe(0);
    });

    it('returns zero tags when response is a JSON object with empty tags array', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: [], caption: 'Empty.', description: 'Nothing here.' }),
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Status → processing (initial upsert)
  // -------------------------------------------------------------------------

  describe('initial status upsert', () => {
    it('upserts MediaTagStatus to processing at the start', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: [], caption: null, description: null }),
      );

      await service.processMediaItem(makeJob());

      const firstUpsert = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock
        .calls[0][0];
      expect(firstUpsert.create.status).toBe(MediaTagStatusType.processing);
      expect(firstUpsert.update.status).toBe(MediaTagStatusType.processing);
    });
  });

  // -------------------------------------------------------------------------
  // Not configured: provider/model null → markFailed + return (no throw)
  // -------------------------------------------------------------------------

  describe('tagging not configured', () => {
    it('marks status failed and returns (does not throw) when provider is null', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSystemSettings(null, 'gpt-4o'),
      );

      // Should NOT throw
      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // markFailed must have been called
      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaTagStatusType.failed }),
          update: expect.objectContaining({ status: MediaTagStatusType.failed }),
        }),
      );
    });

    it('marks status failed and returns (does not throw) when model is null', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSystemSettings('openai', null),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaTagStatusType.failed }),
        }),
      );
    });

    it('sets a descriptive lastError when not configured', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSystemSettings(null, null),
      );

      await service.processMediaItem(makeJob());

      const failedUpsert = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].create.status === MediaTagStatusType.failed,
      );
      expect(failedUpsert).toBeDefined();
      const lastError: string = failedUpsert![0].create.lastError;
      expect(lastError).toMatch(/not configured/i);
    });

    it('marks status failed and returns when system settings row is null', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaTagStatusType.failed }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Credential resolution failure → markFailed + return (no throw)
  // -------------------------------------------------------------------------

  describe('credential resolution failure', () => {
    it('marks status failed and returns when resolveCredentials throws', async () => {
      mockAiSettingsService.resolveCredentials.mockRejectedValue(
        new Error('No credentials configured for openai'),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: MediaTagStatusType.failed,
            lastError: 'No credentials configured for openai',
          }),
        }),
      );
    });

    it('includes providerKey in markFailed call when credentials fail', async () => {
      mockAiSettingsService.resolveCredentials.mockRejectedValue(
        new Error('creds missing'),
      );

      await service.processMediaItem(makeJob());

      const failCall = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].create.status === MediaTagStatusType.failed,
      );
      expect(failCall![0].create.providerKey).toBe('openai');
    });
  });

  // -------------------------------------------------------------------------
  // Skip gates: non-photo, soft-deleted, not found
  // -------------------------------------------------------------------------

  describe('skip gates', () => {
    it('skips and marks failed when mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // Should not call analyzeImage
      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaTagStatusType.failed }),
        }),
      );
    });

    it('skips and marks failed when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });

    it('skips and marks failed when mediaItem type is video', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });

    it('skips and marks failed when mediaItem has no storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No enabled TagLabels → processed with tagCount=0
  // -------------------------------------------------------------------------

  describe('no enabled TagLabels', () => {
    it('upserts MediaTagStatus to processed with tagCount=0 when vocab is empty', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      // analyzeImage should NOT be called (no labels to send)
      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();

      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
      expect(finalUpsert.create.tagCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Provider analyzeImage throws → markFailed and rethrow
  // -------------------------------------------------------------------------

  describe('provider analyzeImage throws', () => {
    it('marks status failed and rethrows when analyzeImage throws', async () => {
      mockProvider.analyzeImage.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow(
        'API rate limit exceeded',
      );

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaTagStatusType.failed }),
          update: expect.objectContaining({ status: MediaTagStatusType.failed }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Image selection hardening: mimeType propagation + byte-size guard
  // -------------------------------------------------------------------------

  describe('image selection hardening', () => {
    // Helper to make sharp simulate preprocessing failure (width: 0)
    function makeSharpFail() {
      const failPipeline = {
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue({
          data: Buffer.from(''),
          info: { width: 0, height: 0 },
        }),
      };
      (jest.requireMock('sharp') as jest.Mock).mockReturnValue(failPipeline);
    }

    beforeEach(() => {
      // Default: analyzeImage returns valid tags in object format
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'A beach.', description: 'Sandy shores.' }),
      );
    });

    // -----------------------------------------------------------------------
    // Happy path: prepared JPEG → mimeType image/jpeg
    // -----------------------------------------------------------------------
    it('calls analyzeImage with mimeType image/jpeg when preprocessing succeeds', async () => {
      // Sharp mock returns width: 800 — preprocessing succeeds
      mockDetectImageMime.mockReturnValue(null); // should not be called on happy path

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
      // detectImageMime must NOT have been called (happy path skips it)
      expect(mockDetectImageMime).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Fallback path: preprocessing fails, PNG buffer → mimeType image/png
    // -----------------------------------------------------------------------
    it('calls analyzeImage with mimeType image/png when preprocessing fails and buffer is PNG', async () => {
      makeSharpFail();
      mockDetectImageMime.mockReturnValue('image/png');

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mimeType: 'image/png' }),
      );
    });

    // -----------------------------------------------------------------------
    // Fallback path: preprocessing fails, unsupported format → markFailed, no analyzeImage
    // -----------------------------------------------------------------------
    it('marks failed and does NOT call analyzeImage when format is unsupported (HEIC/unknown)', async () => {
      makeSharpFail();
      mockDetectImageMime.mockReturnValue(null); // HEIC/unknown → null

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();

      const failedUpsert = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].create.status === MediaTagStatusType.failed,
      );
      expect(failedUpsert).toBeDefined();
      expect(failedUpsert![0].create.lastError).toMatch(/unsupported|undecodable/i);
    });

    // -----------------------------------------------------------------------
    // Byte-size guard: image over MAX_IMAGE_BYTES → markFailed, no analyzeImage
    // -----------------------------------------------------------------------
    it('marks failed and does NOT call analyzeImage when image exceeds MAX_IMAGE_BYTES', async () => {
      // Override the storage download to return a 5MB buffer
      const oversizedBuffer = Buffer.alloc(5_000_000, 0);
      mockStorageProvider.download.mockResolvedValue(Readable.from([oversizedBuffer]));

      // Sharp returns the oversized buffer but with a real width (happy path otherwise)
      const bigPipeline = {
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue({
          data: oversizedBuffer,
          info: { width: 1568, height: 1000 },
        }),
      };
      (jest.requireMock('sharp') as jest.Mock).mockReturnValue(bigPipeline);

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();

      const failedUpsert = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].create.status === MediaTagStatusType.failed,
      );
      expect(failedUpsert).toBeDefined();
      expect(failedUpsert![0].create.lastError).toMatch(/exceeds maximum size/i);
    });
  });

  // -------------------------------------------------------------------------
  // AI tag reconciliation: deleteMany stale + upsert current with source=ai
  // -------------------------------------------------------------------------

  describe('AI tag reconciliation', () => {
    it('calls tx.mediaTag.deleteMany with notIn: normalizedLabels to remove stale AI tags', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Mountains', 'Outdoors'], caption: 'Mountains.', description: 'High peaks.' }),
      );
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
        { name: 'Backyard' },
        { name: 'Mountains' },
        { name: 'Outdoors' },
        { name: 'Vacation' },
      ]);
      (mockPrisma.tag.upsert as jest.Mock).mockResolvedValue({ id: 'tag-1' });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          source: 'ai',
          tag: { name: { notIn: ['Mountains', 'Outdoors'] } },
        },
      });
    });

    it('upserts current labels with source=ai in create and empty update (no manual downgrade)', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Mountains'], caption: 'Mountain.', description: 'Peak.' }),
      );
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([{ name: 'Mountains' }]);
      (mockPrisma.tag.upsert as jest.Mock).mockResolvedValue({ id: 'tag-mountains' });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledWith({
        where: { tagId_mediaItemId: { tagId: 'tag-mountains', mediaItemId: 'media-1' } },
        create: { tagId: 'tag-mountains', mediaItemId: 'media-1', source: 'ai' },
        update: {},
      });
    });

    it('calls deleteMany with notIn: [] when model returns empty tags (all AI tags removed)', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: [], caption: 'Empty.', description: 'Nothing.' }),
      );
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
        { name: 'Beach' },
        { name: 'Sunset' },
      ]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          source: 'ai',
          tag: { name: { notIn: [] } },
        },
      });
      // No upsert calls since no labels produced
      expect(mockPrisma.mediaTag.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // recordModel call
  // -------------------------------------------------------------------------

  describe('recordModel integration', () => {
    it('calls enrichmentJobService.recordModel with job.id, provider, and model on the happy path', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      expect(mockEnrichmentJobService.recordModel).toHaveBeenCalledWith(
        'job-1',
        'openai',
        'gpt-4o',
      );
    });

    it('does NOT call recordModel when provider is not configured', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSystemSettings(null, 'gpt-4o'),
      );

      await service.processMediaItem(makeJob());

      expect(mockEnrichmentJobService.recordModel).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Caption and description persistence
  // -------------------------------------------------------------------------

  describe('caption and description persistence', () => {
    it('persists caption and description via tx.mediaItem.update when parse succeeds', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({
          tags: ['Beach'],
          caption: 'A sunny beach.',
          description: 'Waves crash on a sandy shore.',
        }),
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: {
          caption: 'A sunny beach.',
          description: 'Waves crash on a sandy shore.',
        },
      });
    });

    it('does NOT call tx.mediaItem.update when response is not parseable (parseOk=false)', async () => {
      mockProvider.analyzeImage.mockResolvedValue('This is not JSON at all.');

      await service.processMediaItem(makeJob());

      // mediaItem.update should not be called because parseOk is false
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('persists null caption when caption is missing from the JSON object', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], description: 'Shore.' }),
      );

      await service.processMediaItem(makeJob());

      // The update IS called with parseOk=true (object was valid), caption=null
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: {
          caption: null,
          description: 'Shore.',
        },
      });
    });

    it('still processes tags=[] and sets tagCount=0 even when parse succeeds with empty tags', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: [], caption: 'Empty scene.', description: 'Nothing visible.' }),
      );

      await service.processMediaItem(makeJob());

      // mediaItem.update called (parseOk=true)
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: { caption: 'Empty scene.', description: 'Nothing visible.' },
      });

      // Status reflects tagCount=0 but processed
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
      expect(finalUpsert.create.tagCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // People names in prompt
  // -------------------------------------------------------------------------

  describe('people names in prompt', () => {
    it('queries face.findMany with personId not null and non-deleted/non-merged person', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      const findManyCalls = (mockPrisma.face.findMany as jest.Mock).mock.calls;
      // find the face.findMany call (could be multiple due to tx, pick the one scoped to media item)
      const faceLookup = findManyCalls.find(
        (c: any[]) => c[0]?.where?.mediaItemId === 'media-1',
      );
      expect(faceLookup).toBeDefined();
      expect(faceLookup![0].where).toMatchObject({
        mediaItemId: 'media-1',
        personId: { not: null },
        person: { deletedAt: null, mergedIntoId: null },
      });
    });

    it('includes named people in the prompt passed to analyzeImage', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { person: { name: 'Alice' } },
        { person: { name: 'Bob' } },
      ]);
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Alice and Bob.', description: 'Two people on a beach.' }),
      );

      await service.processMediaItem(makeJob());

      const analyzeCall = (mockProvider.analyzeImage as jest.Mock).mock.calls[0];
      const promptArg = analyzeCall[1].prompt as string;
      expect(promptArg).toContain('Alice');
      expect(promptArg).toContain('Bob');
    });

    it('does not include null person names in the prompt', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { person: { name: null } },
        { person: { name: 'Carol' } },
      ]);
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: [], caption: null, description: null }),
      );

      await service.processMediaItem(makeJob());

      const analyzeCall = (mockProvider.analyzeImage as jest.Mock).mock.calls[0];
      const promptArg = analyzeCall[1].prompt as string;
      expect(promptArg).toContain('Carol');
      // "null" should not appear as a name
      expect(promptArg).not.toMatch(/\bnull\b/);
    });

    it('works correctly when there are no assigned persons (empty face list)', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();
      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Best-effort embedding: embedAndStore
  // -------------------------------------------------------------------------

  describe('embedAndStore: best-effort embedding', () => {
    it('skips embedding gracefully when resolveEmbeddingConfig returns null', async () => {
      mockAiSettingsService.resolveEmbeddingConfig.mockResolvedValue(null);
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      // Must NOT throw
      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // $executeRaw must NOT be called for embedding upsert
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('calls embedText and $executeRaw when embedding is configured', async () => {
      mockAiSettingsService.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      // On second call to resolveCredentials (for embedding), return different creds
      mockAiSettingsService.resolveCredentials
        .mockResolvedValueOnce({ apiKey: 'tagging-key' }) // tagging creds
        .mockResolvedValueOnce({ apiKey: 'embedding-key' }); // embedding creds
      // registry.get returns tagging provider first, then embedding provider
      mockRegistry.get
        .mockReturnValueOnce(mockProvider) // tagging provider (for analyzeImage)
        .mockReturnValueOnce(mockAiProviderForEmbedding); // embedding provider
      mockAiProviderForEmbedding.embedText.mockResolvedValue([0.1, 0.2, 0.3]);
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await service.processMediaItem(makeJob());

      expect(mockAiProviderForEmbedding.embedText).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'embedding-key' }),
        'text-embedding-3-small',
        expect.any(String),
      );
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('swallows embedText errors — tagging job still succeeds', async () => {
      mockAiSettingsService.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      mockAiSettingsService.resolveCredentials
        .mockResolvedValueOnce({ apiKey: 'tagging-key' })
        .mockResolvedValueOnce({ apiKey: 'embedding-key' });
      mockRegistry.get
        .mockReturnValueOnce(mockProvider)
        .mockReturnValueOnce(mockAiProviderForEmbedding);
      mockAiProviderForEmbedding.embedText.mockRejectedValue(new Error('Embedding API down'));
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      // Must NOT throw even though embedding failed
      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // Status should still be processed
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
    });

    it('swallows resolveCredentials errors for embedding provider — tagging job still succeeds', async () => {
      mockAiSettingsService.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      // First resolveCredentials call succeeds (tagging), second fails (embedding)
      mockAiSettingsService.resolveCredentials
        .mockResolvedValueOnce({ apiKey: 'tagging-key' })
        .mockRejectedValueOnce(new Error('Embedding creds not configured'));
      mockProvider.analyzeImage.mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], caption: 'Beach.', description: 'Sand.' }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // $executeRaw should NOT be called since credential resolution failed
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();

      // Tagging status still processed
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
    });

    it('skips embedding when caption, description, tags, and peopleNames are all empty', async () => {
      mockAiSettingsService.resolveEmbeddingConfig.mockResolvedValue({
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
      mockProvider.analyzeImage.mockResolvedValue('Not parseable JSON');

      await service.processMediaItem(makeJob());

      // Tags are empty, caption/description null from parse failure, no people
      // embedAndStore should bail early (no text to embed)
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
