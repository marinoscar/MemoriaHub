/**
 * Unit tests for SocialMediaOcrService.
 *
 * Lightweight coverage focused on the documented never-throws / sticky-degraded
 * contract:
 *   - getStatus() reflects available vs. degraded shape.
 *   - recognizeVideo() returns { available: false, texts: [] } in degraded mode
 *     without throwing, once worker init has failed (sticky).
 *   - recognizeVideo() honors the soft timeout and returns whatever text was
 *     collected so far (partial results) with available:true.
 *
 * tesseract.js's createWorker is mocked module-wide; VideoFrameExtractionService
 * is mocked via DI.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SocialMediaOcrService } from './social-media-ocr.service';
import { VideoFrameExtractionService } from '../face/video-frame-extraction.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

const mockCreateWorker = jest.fn();

jest.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

describe('SocialMediaOcrService', () => {
  let service: SocialMediaOcrService;
  let mockFrameExtractor: { extractFramesAt: jest.Mock };

  function makeFakePage(words: Array<{ text: string; confidence: number }>) {
    return {
      blocks: [
        {
          paragraphs: [
            {
              lines: [{ words }],
            },
          ],
        },
      ],
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    mockFrameExtractor = { extractFramesAt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialMediaOcrService,
        { provide: VideoFrameExtractionService, useValue: mockFrameExtractor },
        { provide: SystemSettingsService, useValue: { getSettings: jest.fn() } },
      ],
    }).compile();

    service = module.get<SocialMediaOcrService>(SocialMediaOcrService);
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------
  describe('getStatus', () => {
    it('returns an available/non-degraded shape when the worker initializes successfully', async () => {
      mockCreateWorker.mockResolvedValue({ recognize: jest.fn(), terminate: jest.fn() });

      const status = await service.getStatus();

      expect(status).toMatchObject({
        ocrAvailable: true,
        degraded: false,
        languages: ['eng'],
      });
      expect(status.modelPath).toContain('tesseract');
    });

    it('returns a degraded shape when worker initialization fails', async () => {
      mockCreateWorker.mockRejectedValue(new Error('wasm load failed'));

      const status = await service.getStatus();

      expect(status).toMatchObject({ ocrAvailable: false, degraded: true });
    });
  });

  // -------------------------------------------------------------------------
  // recognizeVideo — degraded mode (sticky)
  // -------------------------------------------------------------------------
  describe('recognizeVideo — degraded mode', () => {
    it('returns { available: false, texts: [] } without throwing when worker init fails', async () => {
      mockCreateWorker.mockRejectedValue(new Error('wasm load failed'));

      const result = await service.recognizeVideo(Buffer.from('video-bytes'), {
        durationMs: 5000,
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });

      expect(result).toEqual({ available: false, texts: [] });
      // Frame extraction should never even be attempted once worker init fails.
      expect(mockFrameExtractor.extractFramesAt).not.toHaveBeenCalled();
    });

    it('stays degraded (sticky) on a subsequent call without re-attempting worker init', async () => {
      mockCreateWorker.mockRejectedValue(new Error('wasm load failed'));

      await service.recognizeVideo(Buffer.from('a'), {
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });
      mockCreateWorker.mockClear();

      const secondResult = await service.recognizeVideo(Buffer.from('b'), {
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });

      expect(secondResult).toEqual({ available: false, texts: [] });
      // The degraded short-circuit at the top of recognizeVideo means
      // createWorker is never called again.
      expect(mockCreateWorker).not.toHaveBeenCalled();
    });

    it('never throws even when createWorker rejects', async () => {
      mockCreateWorker.mockRejectedValue(new Error('boom'));

      await expect(
        service.recognizeVideo(Buffer.from('x'), {
          maxFrames: 4,
          languages: ['eng'],
          timeoutMs: 1000,
        }),
      ).resolves.toEqual({ available: false, texts: [] });
    });
  });

  // -------------------------------------------------------------------------
  // recognizeVideo — no frames extracted
  // -------------------------------------------------------------------------
  describe('recognizeVideo — frame extraction returns nothing', () => {
    it('returns { available: true, texts: [] } when no frames could be extracted', async () => {
      mockCreateWorker.mockResolvedValue({ recognize: jest.fn(), terminate: jest.fn() });
      mockFrameExtractor.extractFramesAt.mockResolvedValue([]);

      const result = await service.recognizeVideo(Buffer.from('video-bytes'), {
        durationMs: 5000,
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });

      expect(result).toEqual({ available: true, texts: [] });
    });

    it('returns { available: true, texts: [] } (not throw) when frame extraction itself throws', async () => {
      mockCreateWorker.mockResolvedValue({ recognize: jest.fn(), terminate: jest.fn() });
      mockFrameExtractor.extractFramesAt.mockRejectedValue(new Error('ffmpeg exploded'));

      const result = await service.recognizeVideo(Buffer.from('video-bytes'), {
        durationMs: 5000,
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });

      expect(result).toEqual({ available: true, texts: [] });
    });
  });

  // -------------------------------------------------------------------------
  // recognizeVideo — timeout returns partial texts
  // -------------------------------------------------------------------------
  describe('recognizeVideo — soft timeout returns partial results', () => {
    it('returns collected text from completed frames and stops waiting on the budget elapsing', async () => {
      const recognize = jest
        .fn()
        // First frame resolves quickly with confident text.
        .mockImplementationOnce(
          async () =>
            ({ data: makeFakePage([{ text: 'PARTIAL1', confidence: 90 }]) }) as any,
        )
        // Second frame hangs well beyond the timeout budget.
        .mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ data: makeFakePage([{ text: 'TOO_LATE', confidence: 90 }]) } as any),
                300,
              ),
            ),
        );

      mockCreateWorker.mockResolvedValue({ recognize, terminate: jest.fn() });
      mockFrameExtractor.extractFramesAt.mockResolvedValue([
        { timestampMs: 0, buffer: Buffer.from('frame0') },
        { timestampMs: 100, buffer: Buffer.from('frame1') },
      ]);

      const result = await service.recognizeVideo(Buffer.from('video-bytes'), {
        durationMs: 5000,
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 40,
      });

      expect(result.available).toBe(true);
      expect(result.texts).toEqual(['PARTIAL1']);
      expect(result.texts).not.toContain('TOO_LATE');
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // recognizeVideo — confidence filtering
  // -------------------------------------------------------------------------
  describe('recognizeVideo — word confidence filtering', () => {
    it('drops words below the confidence threshold and keeps words at/above it', async () => {
      const recognize = jest.fn().mockResolvedValue({
        data: makeFakePage([
          { text: 'HighConf', confidence: 95 },
          { text: 'LowConf', confidence: 10 },
          { text: 'AtThreshold', confidence: 60 },
        ]),
      } as any);

      mockCreateWorker.mockResolvedValue({ recognize, terminate: jest.fn() });
      mockFrameExtractor.extractFramesAt.mockResolvedValue([
        { timestampMs: 0, buffer: Buffer.from('frame0') },
      ]);

      const result = await service.recognizeVideo(Buffer.from('video-bytes'), {
        durationMs: 1000,
        maxFrames: 4,
        languages: ['eng'],
        timeoutMs: 5000,
      });

      expect(result.available).toBe(true);
      expect(result.texts).toEqual(['HighConf AtThreshold']);
    });
  });
});
