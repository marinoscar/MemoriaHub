import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';

// Mock fluent-ffmpeg before imports
const mockFfmpeg = vi.fn();
const mockFfprobe = vi.fn();
const mockGetAvailableFormats = vi.fn();

vi.mock('fluent-ffmpeg', () => {
  const ffmpegFn = (inputPath: string) => {
    const instance = {
      seekInput: vi.fn().mockReturnThis(),
      frames: vi.fn().mockReturnThis(),
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis(),
      on: vi.fn().mockImplementation(function (this: typeof instance, event: string, callback: (err?: Error) => void) {
        if (event === 'end') {
          (instance as typeof instance & { _endCallback?: () => void })._endCallback = callback;
        }
        if (event === 'error') {
          (instance as typeof instance & { _errorCallback?: (err: Error) => void })._errorCallback = callback;
        }
        return this;
      }),
      run: vi.fn(),
    };
    mockFfmpeg.mockReturnValue(instance);
    return instance;
  };

  ffmpegFn.ffprobe = mockFfprobe;
  ffmpegFn.getAvailableFormats = mockGetAvailableFormats;

  return {
    default: ffmpegFn,
  };
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}));

// Mock the config
vi.mock('../../../src/config/index.js', () => ({
  workerConfig: {
    tempFiles: {
      directory: '/tmp/worker-test',
    },
  },
}));

// Mock the logger
vi.mock('../../../src/infrastructure/logging/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    PROCESSOR_STARTED: 'processor.started',
    PROCESSOR_COMPLETED: 'processor.completed',
    PROCESSOR_ERROR: 'processor.error',
  },
}));

import { VideoProcessor } from '../../../src/processors/video.processor.js';

describe('VideoProcessor', () => {
  let videoProcessor: VideoProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    videoProcessor = new VideoProcessor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDuration', () => {
    it('returns duration in seconds for valid video', async () => {
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, {
          format: {
            duration: 120.5,
          },
        });
      });

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBe(120.5);
    });

    it('returns null when duration is not available', async () => {
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, {
          format: {},
        });
      });

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBeNull();
    });

    it('returns null when ffprobe fails', async () => {
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(new Error('ffprobe error'), { format: {} });
      });

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBeNull();
    });
  });

  describe('isAvailable', () => {
    it('returns true when FFmpeg is available', async () => {
      mockGetAvailableFormats.mockImplementation((callback: (err: Error | null) => void) => {
        callback(null);
      });

      const available = await videoProcessor.isAvailable();

      expect(available).toBe(true);
    });

    it('returns false when FFmpeg is not available', async () => {
      mockGetAvailableFormats.mockImplementation((callback: (err: Error | null) => void) => {
        callback(new Error('FFmpeg not found'));
      });

      const available = await videoProcessor.isAvailable();

      expect(available).toBe(false);
    });
  });

  describe('cleanupFrame', () => {
    it('removes the frame file', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await videoProcessor.cleanupFrame('/tmp/frame-123.jpg');

      expect(fs.unlink).toHaveBeenCalledWith('/tmp/frame-123.jpg');
    });

    it('logs warning but does not throw when cleanup fails', async () => {
      vi.mocked(fs.unlink).mockRejectedValue(new Error('File not found'));

      // Should not throw
      await expect(videoProcessor.cleanupFrame('/tmp/frame-123.jpg')).resolves.not.toThrow();
    });
  });

  describe('extractFrame', () => {
    it('extracts frame at calculated timestamp for videos longer than 10 seconds', async () => {
      // Setup: video is 20 seconds, so timestamp should be min(1, 20 * 0.1) = 1 second
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, { format: { duration: 20 } });
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({ size: 12345 } as import('fs').Stats);

      // Create a mock ffmpeg instance that will trigger the end callback
      const ffmpegInstance = {
        seekInput: vi.fn().mockReturnThis(),
        frames: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        on: vi.fn().mockImplementation(function (this: typeof ffmpegInstance, event: string, callback: () => void) {
          if (event === 'end') {
            // Store callback to call later
            setTimeout(() => callback(), 0);
          }
          return this;
        }),
        run: vi.fn(),
      };

      mockFfmpeg.mockReturnValue(ffmpegInstance);

      const result = await videoProcessor.extractFrame('/path/to/video.mp4');

      expect(result.timestamp).toBe(1);
      expect(result.durationSeconds).toBe(20);
      expect(result.framePath).toMatch(/^\/tmp\/worker-test\/frame-\d+\.jpg$/);
      expect(ffmpegInstance.seekInput).toHaveBeenCalledWith(1);
      expect(ffmpegInstance.frames).toHaveBeenCalledWith(1);
    });

    it('extracts frame at 10% duration for short videos', async () => {
      // Setup: video is 5 seconds, so timestamp should be min(1, 5 * 0.1) = 0.5 second
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, { format: { duration: 5 } });
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({ size: 12345 } as import('fs').Stats);

      const ffmpegInstance = {
        seekInput: vi.fn().mockReturnThis(),
        frames: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        on: vi.fn().mockImplementation(function (this: typeof ffmpegInstance, event: string, callback: () => void) {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          return this;
        }),
        run: vi.fn(),
      };

      mockFfmpeg.mockReturnValue(ffmpegInstance);

      const result = await videoProcessor.extractFrame('/path/to/video.mp4');

      expect(result.timestamp).toBe(0.5);
      expect(ffmpegInstance.seekInput).toHaveBeenCalledWith(0.5);
    });

    it('falls back to first frame when duration probe fails', async () => {
      // Setup: ffprobe fails, then extraction at timestamp 1 fails, then extraction at 0 succeeds
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(new Error('Probe failed'), { format: {} });
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);

      // First stat call for the primary extraction fails (simulating the file wasn't created)
      // Second stat call for fallback succeeds
      let statCallCount = 0;
      vi.mocked(fs.stat).mockImplementation(async () => {
        statCallCount++;
        if (statCallCount === 1) {
          throw new Error('File not created');
        }
        return { size: 12345 } as import('fs').Stats;
      });

      let callCount = 0;
      const ffmpegInstance = {
        seekInput: vi.fn().mockReturnThis(),
        frames: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        on: vi.fn().mockImplementation(function (this: typeof ffmpegInstance, event: string, callback: (err?: Error) => void) {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          if (event === 'error') {
            // First call fails, second succeeds
            if (callCount === 0) {
              callCount++;
              setTimeout(() => callback(new Error('Extraction failed')), 0);
            }
          }
          return this;
        }),
        run: vi.fn(),
      };

      mockFfmpeg.mockReturnValue(ffmpegInstance);

      const result = await videoProcessor.extractFrame('/path/to/video.mp4');

      // When duration probe fails, timestamp defaults to 1
      // When that fails, fallback uses timestamp 0
      expect(result.timestamp).toBe(0);
      expect(result.durationSeconds).toBeNull();
    });

    it('creates temp directory if it does not exist', async () => {
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, { format: { duration: 10 } });
      });

      // First access call fails (directory doesn't exist)
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({ size: 12345 } as import('fs').Stats);

      const ffmpegInstance = {
        seekInput: vi.fn().mockReturnThis(),
        frames: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        on: vi.fn().mockImplementation(function (this: typeof ffmpegInstance, event: string, callback: () => void) {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          return this;
        }),
        run: vi.fn(),
      };

      mockFfmpeg.mockReturnValue(ffmpegInstance);

      await videoProcessor.extractFrame('/path/to/video.mp4');

      expect(fs.mkdir).toHaveBeenCalledWith('/tmp/worker-test', { recursive: true });
    });

    it('throws error when extracted frame is empty', async () => {
      mockFfprobe.mockImplementation((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
        callback(null, { format: { duration: 10 } });
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);
      // File has 0 bytes
      vi.mocked(fs.stat).mockResolvedValue({ size: 0 } as import('fs').Stats);

      const ffmpegInstance = {
        seekInput: vi.fn().mockReturnThis(),
        frames: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        on: vi.fn().mockImplementation(function (this: typeof ffmpegInstance, event: string, callback: () => void) {
          if (event === 'end') {
            setTimeout(() => callback(), 0);
          }
          return this;
        }),
        run: vi.fn(),
      };

      mockFfmpeg.mockReturnValue(ffmpegInstance);

      // This should trigger the fallback, which will also fail if frame is empty
      await expect(videoProcessor.extractFrame('/path/to/video.mp4')).rejects.toThrow();
    });
  });
});
