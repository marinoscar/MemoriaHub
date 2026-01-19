import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fluent-ffmpeg before imports - define callbacks at module level
let mockFfprobeCallback: ((inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => void) | null = null;
let mockGetAvailableFormatsCallback: ((callback: (err: Error | null) => void) => void) | null = null;

vi.mock('fluent-ffmpeg', () => {
  const ffmpegFn = () => {
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
    return instance;
  };

  ffmpegFn.ffprobe = (inputPath: string, callback: (err: Error | null, metadata: { format?: { duration?: number } }) => void) => {
    if (mockFfprobeCallback) {
      mockFfprobeCallback(inputPath, callback);
    } else {
      callback(null, { format: {} });
    }
  };

  ffmpegFn.getAvailableFormats = (callback: (err: Error | null) => void) => {
    if (mockGetAvailableFormatsCallback) {
      mockGetAvailableFormatsCallback(callback);
    } else {
      callback(null);
    }
  };

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

import * as fs from 'fs/promises';
import { VideoProcessor } from '../../../src/processors/video.processor.js';

describe('VideoProcessor', () => {
  let videoProcessor: VideoProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset callbacks
    mockFfprobeCallback = null;
    mockGetAvailableFormatsCallback = null;
    videoProcessor = new VideoProcessor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDuration', () => {
    it('returns duration in seconds for valid video', async () => {
      mockFfprobeCallback = (_inputPath, callback) => {
        callback(null, {
          format: {
            duration: 120.5,
          },
        });
      };

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBe(120.5);
    });

    it('returns null when duration is not available', async () => {
      mockFfprobeCallback = (_inputPath, callback) => {
        callback(null, {
          format: {},
        });
      };

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBeNull();
    });

    it('returns null when ffprobe fails', async () => {
      mockFfprobeCallback = (_inputPath, callback) => {
        callback(new Error('ffprobe error'), { format: {} });
      };

      const duration = await videoProcessor.getDuration('/path/to/video.mp4');

      expect(duration).toBeNull();
    });
  });

  describe('isAvailable', () => {
    it('returns true when FFmpeg is available', async () => {
      mockGetAvailableFormatsCallback = (callback) => {
        callback(null);
      };

      const available = await videoProcessor.isAvailable();

      expect(available).toBe(true);
    });

    it('returns false when FFmpeg is not available', async () => {
      mockGetAvailableFormatsCallback = (callback) => {
        callback(new Error('FFmpeg not found'));
      };

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
});
