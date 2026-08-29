/**
 * Unit tests for VideoInputResolver (epic #452, issue #456).
 *
 * The single most important property here is the SAFETY PROPERTY: every
 * failure of the streaming path falls back to the proven download path, so the
 * worst case of this feature is exactly today's behavior plus one small probe
 * read. Each fallback branch therefore has its own test asserting a download
 * actually happened — a silent "returned nothing" would be a broken job, not a
 * slow one.
 */

jest.mock('@memoriahub/enrichment-compute/video', () => ({
  probeRangeSeekSuitability: jest.fn(),
}));

jest.mock('../../storage/processing/processors/stream-utils', () => ({
  downloadToTempFile: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { VideoInputResolver } from './video-input.service';
import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';
import { probeRangeSeekSuitability } from '@memoriahub/enrichment-compute/video';
import { downloadToTempFile } from '../../storage/processing/processors/stream-utils';

const mockProbe = probeRangeSeekSuitability as jest.Mock;
const mockDownload = downloadToTempFile as jest.Mock;

const SIGNED_URL = 'https://storage.example/videos/clip.mp4?sig=abc';

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    storageKey: 'videos/clip.mp4',
    storageProvider: 's3',
    bucket: 'test-bucket',
    sizeBytes: BigInt(4_000_000_000),
    extension: '.mp4',
    tempPrefix: 'memoriaHub-vtag-dl-',
    streamingEnabled: true,
    jobId: 'job-1',
    ...overrides,
  } as any;
}

describe('VideoInputResolver', () => {
  let service: VideoInputResolver;
  let mockProvider: { download: jest.Mock; getSignedDownloadUrl: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockCleanup: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockProvider = {
      download: jest.fn().mockResolvedValue({}),
      getSignedDownloadUrl: jest.fn().mockResolvedValue(SIGNED_URL),
    };
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockProvider) };
    mockCleanup = jest.fn().mockResolvedValue(undefined);
    mockDownload.mockResolvedValue({ path: '/tmp/clip.mp4', cleanup: mockCleanup });
    mockProbe.mockResolvedValue({
      verdict: 'suitable',
      detail: 'moov atom at the front (faststart)',
      bytesRead: 65536,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoInputResolver,
        { provide: StorageProviderResolver, useValue: mockResolver },
      ],
    }).compile();

    service = module.get(VideoInputResolver);
  });

  // -------------------------------------------------------------------------

  describe('streaming path', () => {
    it('hands ffmpeg the presigned URL and downloads NOTHING when the probe says suitable', async () => {
      const input = await service.resolve(makeRequest());

      expect(input.mode).toBe('stream');
      expect(input.source).toBe(SIGNED_URL);
      expect(mockDownload).not.toHaveBeenCalled();
      // 64 KB probed instead of the 4 GB object — the entire point.
      expect(input.bytesMoved).toBe(65536);
    });

    it('mints a URL whose TTL comfortably exceeds the 20-minute video job timeout', async () => {
      await service.resolve(makeRequest());

      const [, options] = mockProvider.getSignedDownloadUrl.mock.calls[0];
      // A long ffmpeg session against an expiring URL fails mid-run.
      expect(options.expiresIn).toBeGreaterThan(20 * 60);
    });

    it('has a no-op cleanup — nothing was materialized', async () => {
      const input = await service.resolve(makeRequest());

      await expect(input.cleanup()).resolves.toBeUndefined();
      expect(mockCleanup).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The safety property: every streaming failure falls back to the download.
  // -------------------------------------------------------------------------

  describe('fallback to the proven download path', () => {
    it.each([
      ['not-faststart', 'the index is at the end of the file'],
      ['no-range-support', 'provider answered HTTP 200 without Content-Range'],
      ['unknown', 'container layout not recognized'],
    ])('falls back when the probe verdict is "%s"', async (verdict, detail) => {
      mockProbe.mockResolvedValue({ verdict, detail, bytesRead: 64 });

      const input = await service.resolve(makeRequest());

      expect(input.mode).toBe('download');
      expect(input.source).toBe('/tmp/clip.mp4');
      expect(mockDownload).toHaveBeenCalledTimes(1);
    });

    it('falls back when minting the signed URL throws', async () => {
      mockProvider.getSignedDownloadUrl.mockRejectedValue(new Error('signer unavailable'));

      const input = await service.resolve(makeRequest());

      expect(input.mode).toBe('download');
      expect(mockDownload).toHaveBeenCalledTimes(1);
    });

    it('falls back when the provider returns no URL at all', async () => {
      mockProvider.getSignedDownloadUrl.mockResolvedValue('');

      const input = await service.resolve(makeRequest());

      expect(input.mode).toBe('download');
    });

    it('never probes at all when streaming is disabled by the admin setting', async () => {
      const input = await service.resolve(makeRequest({ streamingEnabled: false }));

      expect(mockProbe).not.toHaveBeenCalled();
      expect(mockProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(input.mode).toBe('download');
      expect(input.reason).toMatch(/disabled/);
    });

    it('passes the size through for the disk-space pre-flight, and reports the real bytes moved', async () => {
      mockProbe.mockResolvedValue({ verdict: 'not-faststart', detail: 'x', bytesRead: 64 });

      const input = await service.resolve(makeRequest());

      expect(mockDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          sizeBytes: BigInt(4_000_000_000),
          prefix: 'memoriaHub-vtag-dl-',
          extension: '.mp4',
        }),
      );
      expect(input.bytesMoved).toBe(4_000_000_000);
    });

    it('returns the downloader’s cleanup so the caller unlinks the temp file', async () => {
      mockProbe.mockResolvedValue({ verdict: 'unknown', detail: 'x', bytesRead: 0 });

      const input = await service.resolve(makeRequest());
      await input.cleanup();

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it('propagates a download failure — that is a real job failure, not something to swallow', async () => {
      mockProbe.mockResolvedValue({ verdict: 'unknown', detail: 'x', bytesRead: 0 });
      mockDownload.mockRejectedValue(new Error('insufficient disk space for video download'));

      await expect(service.resolve(makeRequest())).rejects.toThrow(/insufficient disk space/);
    });
  });
});
