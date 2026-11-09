/**
 * Unit tests for the shared thumbnail renderer (issue #203).
 *
 * These run sharp for real (like image-orientation.util.spec.ts) — the whole
 * point of the module is the pixel contract, so mocking sharp would test
 * nothing. Only the ffmpeg transcode fallback is mocked, since spawning ffmpeg
 * in a unit test is neither fast nor available everywhere.
 */

jest.mock('./image-orientation.util', () => ({
  transcodeToDecodableJpeg: jest.fn(),
}));

import sharp from 'sharp';
import {
  renderThumbnailBuffer,
  resolveThumbnailDefaults,
  THUMBNAIL_CACHE_CONTROL,
} from './thumbnail-render.util';
import { transcodeToDecodableJpeg } from './image-orientation.util';

const mockTranscode = transcodeToDecodableJpeg as jest.Mock;

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 60, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

describe('thumbnail-render.util', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe('THUMBNAIL_CACHE_CONTROL', () => {
    it('is the immutable one-year policy every thumbnail upload shares', () => {
      // Load-bearing: MediaThumbnailService hands out long-TTL signed URLs on
      // the assumption the bytes behind them never change.
      expect(THUMBNAIL_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    });
  });

  describe('resolveThumbnailDefaults', () => {
    it('defaults to 800px / quality 85', () => {
      delete process.env['THUMBNAIL_MAX_DIM'];
      delete process.env['THUMBNAIL_QUALITY'];
      expect(resolveThumbnailDefaults()).toEqual({ maxDim: 800, quality: 85 });
    });

    it('reads THUMBNAIL_MAX_DIM / THUMBNAIL_QUALITY at CALL time, not module load', () => {
      process.env['THUMBNAIL_MAX_DIM'] = '256';
      process.env['THUMBNAIL_QUALITY'] = '50';
      expect(resolveThumbnailDefaults()).toEqual({ maxDim: 256, quality: 50 });
    });
  });

  describe('renderThumbnailBuffer', () => {
    it('downscales a large image inside the max dimension, preserving aspect ratio', async () => {
      const out = await renderThumbnailBuffer(await makeJpeg(1600, 800), { maxDim: 400 });
      const meta = await sharp(out).metadata();

      expect(meta.width).toBe(400);
      expect(meta.height).toBe(200);
      expect(meta.format).toBe('jpeg');
    });

    it('never enlarges an image already smaller than the max dimension', async () => {
      const out = await renderThumbnailBuffer(await makeJpeg(120, 90), { maxDim: 800 });
      const meta = await sharp(out).metadata();

      expect(meta.width).toBe(120);
      expect(meta.height).toBe(90);
    });

    it('honours the env defaults when no explicit options are passed', async () => {
      process.env['THUMBNAIL_MAX_DIM'] = '100';
      const out = await renderThumbnailBuffer(await makeJpeg(1000, 500));
      const meta = await sharp(out).metadata();

      expect(meta.width).toBe(100);
    });

    it('falls back to an ffmpeg transcode when sharp cannot decode the input', async () => {
      // The HEIC path (issue #106): sharp's bundled libvips omits the HEVC
      // decoder, so an undecodable buffer must be transcoded, not dropped.
      mockTranscode.mockResolvedValue(await makeJpeg(600, 400));

      const out = await renderThumbnailBuffer(Buffer.from('not-an-image'), {
        maxDim: 200,
        sourceFilename: 'IMG_0001.HEIC',
      });

      expect(mockTranscode).toHaveBeenCalledWith(expect.any(Buffer), {
        fileExtension: '.HEIC',
      });
      const meta = await sharp(out).metadata();
      expect(meta.width).toBe(200);
    });

    it('throws when even the transcode fallback cannot produce a decodable image', async () => {
      // Callers (ThumbnailProcessor, the enhancement handler) each decide what
      // a hard failure means, so this must surface rather than return garbage.
      mockTranscode.mockResolvedValue(Buffer.from('still-not-an-image'));

      await expect(
        renderThumbnailBuffer(Buffer.from('not-an-image')),
      ).rejects.toThrow();
    });
  });
});
