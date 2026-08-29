/**
 * Unit tests for VideoAutoTaggingService (epic #452, issue #455).
 *
 * The two things worth protecting here are the RESOURCE CEILING (three costs,
 * each bounded, none scaling with video duration) and the GATE LADDER (nothing
 * downstream of a closed gate may make an AI call). Everything else — parsing,
 * vocabulary validation, tag reconciliation — is deliberately NOT retested:
 * this service delegates persistence to AutoTaggingService.persistAutoTagging,
 * the same implementation the photo path uses, and duplicating its coverage
 * here would let the two drift while both suites stayed green.
 */

// sharp is a native module; stub it as the photo spec does.
jest.mock('sharp', () => {
  const mockPipeline = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue({
      data: Buffer.from('processed-frame'),
      info: { width: 800, height: 600 },
    }),
  };
  return jest.fn().mockReturnValue(mockPipeline);
});

// The shared compute package shells out to ffmpeg — stub the two entry points
// this service uses so no binary is required.
jest.mock('@memoriahub/enrichment-compute/video', () => ({
  extractFrames: jest.fn(),
  extractAudioLead: jest.fn(),
}));


import { Test, TestingModule } from '@nestjs/testing';
import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  MediaTagStatusType,
  MediaType,
} from '@prisma/client';
import {
  VideoAutoTaggingService,
  buildVideoTaggingPrompt,
} from './video-auto-tagging.service';
import { AutoTaggingService } from './auto-tagging.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import { VideoInputResolver } from '../media/enrichment/video-input.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { RateLimitError } from '../enrichment/rate-limit.error';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { extractFrames, extractAudioLead } from '@memoriahub/enrichment-compute/video';

const mockExtractFrames = extractFrames as jest.Mock;
const mockExtractAudioLead = extractAudioLead as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'video_auto_tagging',
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
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MediaType.video,
    deletedAt: null,
    durationMs: 30_000,
    socialMediaSource: null,
    storageObject: {
      storageKey: 'videos/clip.mp4',
      storageProvider: 's3',
      bucket: 'test-bucket',
      name: 'clip.mp4',
      size: BigInt(5_000_000),
    },
    ...overrides,
  };
}

/** System settings with every gate open by default. */
function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    key: 'global',
    value: {
      features: { autoTagging: true },
      autoTagging: {
        video: {
          enabled: true,
          maxFrames: 6,
          sampleIntervalSeconds: 5,
          transcription: { enabled: false, leadSeconds: 30 },
        },
      },
      ai: { features: { tagging: { provider: 'openai', model: 'gpt-4o' } } },
      ...overrides,
    },
  };
}

function makeFrames(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestampMs: (i + 1) * 2500,
    buffer: Buffer.from(`frame-${i}`),
  }));
}

// ---------------------------------------------------------------------------

describe('VideoAutoTaggingService', () => {
  let service: VideoAutoTaggingService;
  let mockPrisma: MockPrismaService;
  let mockAiSettings: {
    resolveCredentials: jest.Mock;
    resolveTranscriptionConfig: jest.Mock;
  };
  let mockRegistry: { get: jest.Mock };
  let mockProvider: { analyzeImage: jest.Mock; transcribeAudio?: jest.Mock };
  let mockVideoInput: { resolve: jest.Mock };
  let mockCleanup: jest.Mock;
  let mockEnrichmentJobService: { recordModel: jest.Mock };
  let mockAutoTaggingService: { persistAutoTagging: jest.Mock };
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };

    mockPrisma = createMockPrismaService();
    mockProvider = {
      analyzeImage: jest.fn().mockResolvedValue(
        JSON.stringify({ tags: ['Beach'], description: 'Kids playing at the shore.' }),
      ),
      transcribeAudio: jest.fn().mockResolvedValue({ text: 'happy birthday', language: 'en' }),
    };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockAiSettings = {
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }),
      resolveTranscriptionConfig: jest.fn().mockResolvedValue(null),
    };
    mockCleanup = jest.fn().mockResolvedValue(undefined);
    mockVideoInput = {
      resolve: jest.fn().mockResolvedValue({
        source: '/tmp/video.mp4',
        mode: 'download',
        reason: 'test',
        bytesMoved: 5_000_000,
        cleanup: mockCleanup,
      }),
    };
    mockEnrichmentJobService = { recordModel: jest.fn().mockResolvedValue(undefined) };
    mockAutoTaggingService = { persistAutoTagging: jest.fn().mockResolvedValue(undefined) };

    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(makeSettings());
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
    (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
      { name: 'Beach' },
      { name: 'Birthday' },
    ]);
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.mediaTranscript.upsert as jest.Mock).mockResolvedValue({});

    mockExtractFrames.mockResolvedValue(makeFrames(6));
    mockExtractAudioLead.mockResolvedValue({
      buffer: Buffer.from('audio'),
      mimeType: 'audio/mp4',
      leadSeconds: 30,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoAutoTaggingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AiSettingsService, useValue: mockAiSettings },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: VideoInputResolver, useValue: mockVideoInput },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: AutoTaggingService, useValue: mockAutoTaggingService },
      ],
    }).compile();

    service = module.get(VideoAutoTaggingService);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // =========================================================================
  // Gate ladder — nothing downstream of a closed gate may cost money
  // =========================================================================

  describe('gate ladder', () => {
    it('makes NO AI call when features.autoTagging is off', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
        key: 'global',
        value: { features: { autoTagging: false } },
      });

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });

    it('makes NO AI call when AUTO_TAG_ENABLED=false — video tagging has no kill-switch of its own', async () => {
      process.env['AUTO_TAG_ENABLED'] = 'false';

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });

    it('makes NO AI call when autoTagging.video.enabled is off — the DEFAULT, so an upgrade costs nothing', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSettings({
          autoTagging: { video: { enabled: false } },
        }),
      );

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('skips a flagged social-media re-share without an AI call, and without failing the item', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ socialMediaSource: 'tiktok' }),
      );

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      // A skip, not a failure — the item is correctly classified.
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });

    it('fails a PHOTO routed here by mistake rather than tagging it as a video', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.photo }),
      );

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      const call = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls[0][0];
      expect(call.create.status).toBe(MediaTagStatusType.failed);
      expect(call.create.lastError).toMatch(/not video/);
    });

    it('skips without downloading when the object exceeds VIDEO_ENRICHMENT_MAX_BYTES', async () => {
      process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = '1000';

      await service.processMediaItem(makeJob());

      expect(mockVideoInput.resolve).not.toHaveBeenCalled();
      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });

    it('fails cleanly when no tagging provider/model is configured', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSettings({ ai: { features: { tagging: { provider: null, model: null } } } }),
      );

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      const lastCall = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.at(-1)![0];
      expect(lastCall.update.status).toBe(MediaTagStatusType.failed);
    });

    it('marks processed with zero tags — never calls the model — when the vocabulary is empty', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
      const lastCall = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.at(-1)![0];
      expect(lastCall.update.status).toBe(MediaTagStatusType.processed);
      expect(lastCall.update.tagCount).toBe(0);
    });
  });

  // =========================================================================
  // The resource ceiling
  // =========================================================================

  describe('resource ceiling', () => {
    it('makes exactly ONE AI call carrying every frame, never one call per frame', async () => {
      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
      const req = mockProvider.analyzeImage.mock.calls[0][1];
      expect(req.images).toHaveLength(6);
      // The single-image field must not also be set, or a provider could send
      // a seventh, unrelated image.
      expect(req.imageBase64).toBeUndefined();
    });

    it('passes maxFrames through to the extractor unchanged, for both a short clip and a 3-hour video', async () => {
      await service.processMediaItem(makeJob());
      expect(mockExtractFrames.mock.calls[0][1]).toMatchObject({
        durationMs: 30_000,
        maxFrames: 6,
        sampleIntervalSeconds: 5,
      });

      mockExtractFrames.mockClear();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ durationMs: 3 * 60 * 60 * 1000 }),
      );

      await service.processMediaItem(makeJob());

      // Same frame budget for a 3-hour video — the cost is duration-independent,
      // which is exactly why there is no maxDurationSeconds skip gate.
      expect(mockExtractFrames.mock.calls[0][1]).toMatchObject({ maxFrames: 6 });
    });

    it('raises the per-request output budget so a whole-video description is not truncated', async () => {
      await service.processMediaItem(makeJob());

      const req = mockProvider.analyzeImage.mock.calls[0][1];
      expect(req.maxTokens).toBeGreaterThan(1024);
    });

    it('does NOT skip a 3-hour video — degrade, never skip on duration', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ durationMs: 3 * 60 * 60 * 1000 }),
      );

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
      expect(mockAutoTaggingService.persistAutoTagging).toHaveBeenCalledTimes(1);
    });

    it('drops trailing frames rather than failing when the combined image budget is exceeded', async () => {
      const huge = Buffer.alloc(8_000_000, 1);
      (jest.requireMock('sharp') as jest.Mock).mockReturnValue({
        rotate: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue({ data: huge, info: { width: 800, height: 600 } }),
      });

      await service.processMediaItem(makeJob());

      const req = mockProvider.analyzeImage.mock.calls[0][1];
      expect(req.images.length).toBeGreaterThan(0);
      expect(req.images.length).toBeLessThan(6);
    });
  });

  // =========================================================================
  // Input resolution (issue #456)
  // =========================================================================

  describe('video input', () => {
    it('asks the resolver for the input and hands whatever it returns to ffmpeg', async () => {
      mockVideoInput.resolve.mockResolvedValue({
        source: 'https://storage.example/clip.mp4?sig=abc',
        mode: 'stream',
        reason: 'faststart',
        bytesMoved: 65536,
        cleanup: mockCleanup,
      });

      await service.processMediaItem(makeJob());

      // The compute half is source-agnostic: a URL and a path are both just
      // something ffmpeg can read.
      expect(mockExtractFrames.mock.calls[0][0]).toBe('https://storage.example/clip.mp4?sig=abc');
    });

    it('forwards the admin streamInput setting, defaulting to enabled', async () => {
      await service.processMediaItem(makeJob());
      expect(mockVideoInput.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ streamingEnabled: true }),
      );

      mockVideoInput.resolve.mockClear();
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(
        makeSettings({
          autoTagging: {
            video: {
              enabled: true,
              maxFrames: 6,
              sampleIntervalSeconds: 5,
              transcription: { enabled: false, leadSeconds: 30 },
              streamInput: false,
            },
          },
        }),
      );

      await service.processMediaItem(makeJob());
      expect(mockVideoInput.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ streamingEnabled: false }),
      );
    });

    it('always cleans up the input, including when the AI call throws', async () => {
      mockProvider.analyzeImage.mockRejectedValue(new Error('provider exploded'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow();

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Persist delegation — one implementation of vocabulary validation
  // =========================================================================

  describe('persistence', () => {
    it('delegates the persist half to AutoTaggingService, passing the raw text through unparsed', async () => {
      mockProvider.analyzeImage.mockResolvedValue('{"tags":["Beach"],"description":"d"}');

      const job = makeJob();
      await service.processMediaItem(job);

      expect(mockAutoTaggingService.persistAutoTagging).toHaveBeenCalledWith(job, {
        rawText: '{"tags":["Beach"],"description":"d"}',
      });
    });

    it('records the provider/model on the job row AND the in-memory object before persisting', async () => {
      const job = makeJob();
      await service.processMediaItem(job);

      expect(mockEnrichmentJobService.recordModel).toHaveBeenCalledWith('job-1', 'openai', 'gpt-4o');
      // persistAutoTagging reads these off the same reference without re-fetching.
      expect(job.providerKey).toBe('openai');
      expect(job.modelVersion).toBe('gpt-4o');
    });

    it('marks the item failed and rethrows when the vision call errors, so the queue retries', async () => {
      mockProvider.analyzeImage.mockRejectedValue(new Error('provider exploded'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('provider exploded');

      const lastCall = (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls.at(-1)![0];
      expect(lastCall.update.status).toBe(MediaTagStatusType.failed);
    });

    it('converts a provider 429 into RateLimitError so the job is DEFERRED, not counted as a failure', async () => {
      mockProvider.analyzeImage.mockRejectedValue(
        Object.assign(new Error('slow down'), { status: 429, headers: { 'retry-after': '30' } }),
      );

      await expect(service.processMediaItem(makeJob())).rejects.toBeInstanceOf(RateLimitError);
    });

    it('converts a provider 529 (Anthropic "Overloaded") the same way', async () => {
      mockProvider.analyzeImage.mockRejectedValue(
        Object.assign(new Error('overloaded'), { status: 529 }),
      );

      await expect(service.processMediaItem(makeJob())).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  // =========================================================================
  // Transcription — best-effort by contract
  // =========================================================================

  describe('transcription', () => {
    const withTranscription = () =>
      makeSettings({
        autoTagging: {
          video: {
            enabled: true,
            maxFrames: 6,
            sampleIntervalSeconds: 5,
            transcription: { enabled: true, leadSeconds: 45 },
          },
        },
      });

    beforeEach(() => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(withTranscription());
      mockAiSettings.resolveTranscriptionConfig.mockResolvedValue({
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
      });
    });

    it('never extracts audio at all when transcription is off', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(makeSettings());

      await service.processMediaItem(makeJob());

      expect(mockExtractAudioLead).not.toHaveBeenCalled();
    });

    it('bounds the audio to the configured leadSeconds, not the video duration', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ durationMs: 3 * 60 * 60 * 1000 }),
      );

      await service.processMediaItem(makeJob());

      expect(mockExtractAudioLead.mock.calls[0][1]).toMatchObject({ leadSeconds: 45 });
    });

    it('feeds the transcript into the prompt and persists it with the leadSeconds actually paid for', async () => {
      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage.mock.calls[0][1].prompt).toContain('happy birthday');

      const upsert = (mockPrisma.mediaTranscript.upsert as jest.Mock).mock.calls[0][0];
      expect(upsert.where).toEqual({ mediaItemId: 'media-1' });
      expect(upsert.create).toMatchObject({
        text: 'happy birthday',
        language: 'en',
        leadSeconds: 45,
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
      });
    });

    it('persists the transcript BEFORE persisting tags, so this run’s embedding already includes it', async () => {
      const order: string[] = [];
      (mockPrisma.mediaTranscript.upsert as jest.Mock).mockImplementation(async () => {
        order.push('transcript');
        return {};
      });
      mockAutoTaggingService.persistAutoTagging.mockImplementation(async () => {
        order.push('tags');
      });

      await service.processMediaItem(makeJob());

      expect(order).toEqual(['transcript', 'tags']);
    });

    it('degrades to visual-only when the provider has no audio capability', async () => {
      mockRegistry.get.mockReturnValue({ analyzeImage: mockProvider.analyzeImage });

      await service.processMediaItem(makeJob());

      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaTranscript.upsert).not.toHaveBeenCalled();
    });

    it('degrades to visual-only when no transcription model is configured', async () => {
      mockAiSettings.resolveTranscriptionConfig.mockResolvedValue(null);

      await service.processMediaItem(makeJob());

      expect(mockExtractAudioLead).not.toHaveBeenCalled();
      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
    });

    it('degrades to visual-only when the video has no audio track (ffmpeg fails)', async () => {
      mockExtractAudioLead.mockRejectedValue(new Error('ffmpeg produced an empty output file'));

      await service.processMediaItem(makeJob());

      // The tagging job still succeeds — transcription is an enrichment, not a
      // precondition.
      expect(mockProvider.analyzeImage).toHaveBeenCalledTimes(1);
      expect(mockAutoTaggingService.persistAutoTagging).toHaveBeenCalledTimes(1);
    });

    it('RETHROWS a rate-limited transcription rather than silently producing a worse description', async () => {
      mockProvider.transcribeAudio!.mockRejectedValue(
        Object.assign(new Error('slow down'), { status: 429 }),
      );

      await expect(service.processMediaItem(makeJob())).rejects.toBeInstanceOf(RateLimitError);
      // The visual call must not have happened either — the job is deferred whole.
      expect(mockProvider.analyzeImage).not.toHaveBeenCalled();
    });

    it('still tags when the transcript row cannot be written', async () => {
      (mockPrisma.mediaTranscript.upsert as jest.Mock).mockRejectedValue(new Error('db down'));

      await service.processMediaItem(makeJob());

      expect(mockAutoTaggingService.persistAutoTagging).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Prompt contract
  // =========================================================================

  describe('buildVideoTaggingPrompt', () => {
    it('keeps the photo path’s output envelope so the parse/persist half is reusable verbatim', () => {
      const prompt = buildVideoTaggingPrompt(['Beach', 'Birthday'], [], [0, 5000], null);

      expect(prompt).toContain('"tags"');
      expect(prompt).toContain('"description"');
      expect(prompt).toContain('Allowed labels:\nBeach\nBirthday');
    });

    it('frames the images as ordered stills from ONE video, with their timestamps', () => {
      const prompt = buildVideoTaggingPrompt(['Beach'], [], [2500, 65_000], null);

      expect(prompt).toMatch(/2 still frame\(s\) sampled in order from a single video/);
      expect(prompt).toContain('1. 0:03');
      expect(prompt).toContain('2. 1:05');
      expect(prompt).toMatch(/not as unrelated photos/);
    });

    it('delimits the transcript and flags it as a hint rather than fact', () => {
      const prompt = buildVideoTaggingPrompt(['Beach'], [], [0], 'happy birthday to you');

      expect(prompt).toContain('happy birthday to you');
      expect(prompt).toMatch(/treat it as a hint, not as fact/i);
    });

    it('omits the transcript block entirely when there is none', () => {
      const prompt = buildVideoTaggingPrompt(['Beach'], [], [0], null);

      expect(prompt).not.toMatch(/Transcript/i);
    });

    it('names assigned people, matching the photo prompt’s clause', () => {
      const prompt = buildVideoTaggingPrompt(['Beach'], ['Alice', 'Bob'], [0], null);

      expect(prompt).toContain('Alice, Bob');
      expect(prompt).toMatch(/Mention them by name/);
    });
  });
});
