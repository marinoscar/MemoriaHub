/**
 * Unit tests for VideoProbeProcessor.
 *
 * fluent-ffmpeg is mocked entirely so no real child process is spawned.
 * Tests verify:
 *   - Existing metadata keys (durationMs, width, height, codec, capturedAt) still produced.
 *   - New containerTags key is populated from format.tags.
 *   - hasContainerCreationTime is set correctly.
 *   - Empty / absent format.tags produce empty containerTags (key omitted) but
 *     hasContainerCreationTime is still written (as false).
 *   - Unsupported MIME type: canProcess returns false.
 *   - ffprobe failure returns { success: false }.
 */

// ---------------------------------------------------------------------------
// Mock fluent-ffmpeg BEFORE any imports that import the module
// ---------------------------------------------------------------------------

const mockFfprobeData: import('fluent-ffmpeg').FfprobeData = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      tags: { creation_time: '2024-06-15T10:30:00.000000Z' },
    } as any,
  ],
  format: {
    duration: '62.5',
    tags: {
      major_brand: 'isom',
      encoder: 'Lavf58.29.100',
      creation_time: '2024-06-15T10:30:00.000000Z',
      handler_name: 'Apple QuickTime',
    },
  } as any,
  chapters: [],
};

jest.mock('fluent-ffmpeg', () => {
  const ffmpeg = jest.fn() as any;
  ffmpeg.ffprobe = jest.fn().mockImplementation(
    (_path: string, cb: (err: Error | null, data: any) => void) => {
      cb(null, mockFfprobeData);
    },
  );
  return ffmpeg;
});

// Mock fs.promises so temp files are not actually written/deleted
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: jest.fn().mockResolvedValue(undefined),
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { VideoProbeProcessor } from './video-probe.processor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStorageObject(overrides: Partial<any> = {}) {
  return {
    id: 'obj-1',
    name: 'clip.mp4',
    size: BigInt(1024 * 1024),
    mimeType: 'video/mp4',
    storageKey: 'videos/clip.mp4',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'processing',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStream(): () => Promise<Readable> {
  return () => Promise.resolve(Readable.from([Buffer.from('fake-video-bytes')]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoProbeProcessor', () => {
  let processor: VideoProbeProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VideoProbeProcessor],
    }).compile();
    processor = module.get<VideoProbeProcessor>(VideoProbeProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore default mock probe data for next test
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpeg = require('fluent-ffmpeg') as any;
    ffmpeg.ffprobe.mockImplementation(
      (_path: string, cb: (err: Error | null, data: any) => void) => {
        cb(null, mockFfprobeData);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // canProcess
  // ---------------------------------------------------------------------------

  describe('canProcess()', () => {
    it('returns true for video/mp4', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/mp4' }) as any)).toBe(true);
    });

    it('returns true for video/quicktime', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/quicktime' }) as any)).toBe(true);
    });

    it('returns false for image/jpeg', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/jpeg' }) as any)).toBe(false);
    });

    it('returns false for application/pdf', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'application/pdf' }) as any)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Existing metadata keys — must not regress
  // ---------------------------------------------------------------------------

  describe('existing metadata output (regression)', () => {
    it('emits durationMs from format.duration', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.success).toBe(true);
      expect(result.metadata!['durationMs']).toBe(62500); // 62.5 * 1000 rounded
    });

    it('emits width from the video stream', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['width']).toBe(1920);
    });

    it('emits height from the video stream', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['height']).toBe(1080);
    });

    it('emits codec from the video stream', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['codec']).toBe('h264');
    });

    it('emits capturedAt as ISO-8601 string from format.tags.creation_time', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['capturedAt']).toBe(
        new Date('2024-06-15T10:30:00.000000Z').toISOString(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // New: containerTags populated from format.tags
  // ---------------------------------------------------------------------------

  describe('containerTags output (new)', () => {
    it('emits containerTags with encoder value', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.success).toBe(true);
      const containerTags = result.metadata!['containerTags'] as Record<string, string>;
      expect(containerTags).toBeDefined();
      expect(containerTags['encoder']).toBe('lavf58.29.100'); // lowercased
    });

    it('emits containerTags with major_brand', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      const containerTags = result.metadata!['containerTags'] as Record<string, string>;
      expect(containerTags['major_brand']).toBe('isom');
    });

    it('emits containerTags with handler_name', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      const containerTags = result.metadata!['containerTags'] as Record<string, string>;
      expect(containerTags['handler_name']).toBe('apple quicktime'); // lowercased
    });

    it('omits containerTags key entirely when format.tags has no known keys', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(null, {
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
            format: { duration: '10.0', tags: {} },
            chapters: [],
          });
        },
      );

      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.success).toBe(true);
      // containerTags key should be absent when no known tags found
      expect(result.metadata!['containerTags']).toBeUndefined();
    });

    it('includes android container tag when present', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(null, {
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }],
            format: {
              duration: '30.0',
              tags: {
                'com.android.manufacturer': 'Samsung',
                'com.android.version': '14',
              },
            },
            chapters: [],
          });
        },
      );

      const result = await processor.process(makeStorageObject() as any, makeStream());
      const tags = result.metadata!['containerTags'] as Record<string, string>;
      expect(tags['com.android.manufacturer']).toBe('samsung');
      expect(tags['com.android.version']).toBe('14');
    });
  });

  // ---------------------------------------------------------------------------
  // New: hasContainerCreationTime
  // ---------------------------------------------------------------------------

  describe('hasContainerCreationTime output (new)', () => {
    it('is true when format.tags.creation_time is present', async () => {
      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['hasContainerCreationTime']).toBe(true);
    });

    it('is false when no creation_time tag is present in format or video stream', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(null, {
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }],
            format: { duration: '30.0', tags: { encoder: 'Lavf58' } },
            chapters: [],
          });
        },
      );

      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['hasContainerCreationTime']).toBe(false);
    });

    it('is true when creation_time is in the video stream tags (not format)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(null, {
            streams: [
              {
                codec_type: 'video',
                codec_name: 'h264',
                width: 1080,
                height: 1920,
                tags: { creation_time: '2024-01-01T00:00:00.000Z' },
              },
            ],
            format: { duration: '30.0', tags: {} },
            chapters: [],
          });
        },
      );

      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.metadata!['hasContainerCreationTime']).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Error path
  // ---------------------------------------------------------------------------

  describe('ffprobe failure', () => {
    it('returns { success: false, error } when ffprobe throws', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(new Error('No such file or directory'), null as any);
        },
      );

      const result = await processor.process(makeStorageObject() as any, makeStream());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No such file/);
    });
  });
});
