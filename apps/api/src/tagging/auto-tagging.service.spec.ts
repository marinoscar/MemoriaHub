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
  let mockAiSettingsService: { resolveCredentials: jest.Mock };
  let mockRegistry: { get: jest.Mock };
  let mockProvider: { analyzeImage: jest.Mock };
  let mockStorageProvider: { download: jest.Mock };

  beforeEach(async () => {
    (jest.requireMock('sharp') as jest.Mock).mockClear();

    mockPrisma = createMockPrismaService();
    mockProvider = { analyzeImage: jest.fn() };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockAiSettingsService = {
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }),
    };
    mockStorageProvider = {
      download: jest.fn().mockResolvedValue(makeReadable()),
    };

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
    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoTaggingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AiSettingsService, useValue: mockAiSettingsService },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
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
        '["Beach", "Sunset", "Nonexistent Label"]',
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
      mockProvider.analyzeImage.mockResolvedValue('["Beach", "Sunset"]');

      (mockPrisma.tag.upsert as jest.Mock)
        .mockResolvedValueOnce({ id: 'tag-beach' })
        .mockResolvedValueOnce({ id: 'tag-sunset' });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledTimes(2);
    });

    it('sets MediaTagStatus to processed with correct tagCount, providerKey, and modelVersion', async () => {
      mockProvider.analyzeImage.mockResolvedValue('["Beach", "Sunset"]');

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
      mockProvider.analyzeImage.mockResolvedValue('["Beach"]');

      await service.processMediaItem(makeJob());

      const tagUpsertCall = (mockPrisma.tag.upsert as jest.Mock).mock.calls[0][0];
      expect(tagUpsertCall.create.addedById).toBe('user-1');
    });

    it('sets Tag.circleId to the media item circleId', async () => {
      mockProvider.analyzeImage.mockResolvedValue('["Beach"]');

      await service.processMediaItem(makeJob());

      const tagUpsertCall = (mockPrisma.tag.upsert as jest.Mock).mock.calls[0][0];
      expect(tagUpsertCall.create.circleId).toBe('circle-1');
    });

    it('deduplicates identical labels returned by the provider', async () => {
      // Provider returns Beach twice
      mockProvider.analyzeImage.mockResolvedValue('["Beach", "Beach", "Sunset"]');

      await service.processMediaItem(makeJob());

      // Only 2 unique labels: Beach, Sunset
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('normalizes label case to match the original TagLabel name', async () => {
      // Provider returns lowercase variant
      mockProvider.analyzeImage.mockResolvedValue('["beach", "sunset"]');

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

  describe('parseTagArray: robust JSON extraction', () => {
    it('parses response wrapped in triple-backtick json fences', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        '```json\n["Beach", "Sunset"]\n```',
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('parses response with leading prose before the JSON array', async () => {
      mockProvider.analyzeImage.mockResolvedValue(
        'Here are the applicable labels: ["Beach", "Mountain"]',
      );

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
    });

    it('returns zero tags when response is not parseable JSON', async () => {
      mockProvider.analyzeImage.mockResolvedValue('I cannot identify any labels.');

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
      // Status should still be processed with tagCount=0
      const calls = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaTagStatusType.processed);
      expect(finalUpsert.create.tagCount).toBe(0);
    });

    it('returns zero tags when response is an empty array', async () => {
      mockProvider.analyzeImage.mockResolvedValue('[]');

      await service.processMediaItem(makeJob());

      expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Status → processing (initial upsert)
  // -------------------------------------------------------------------------

  describe('initial status upsert', () => {
    it('upserts MediaTagStatus to processing at the start', async () => {
      mockProvider.analyzeImage.mockResolvedValue('[]');

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
});
