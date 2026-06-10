/**
 * Unit tests — VideoProbeProcessor
 *
 * ffprobe binary is not available in this CI environment (no system ffmpeg
 * installed).  Generating a real MP4 fixture and running a real ffprobe probe
 * is therefore not feasible.  Instead, `fluent-ffmpeg` is mocked at the module
 * level so the processor's mapping logic (durationMs/width/height/codec) is
 * fully exercised without any binary dependency.
 *
 * `canProcess` is asserted against a real processor instance — it doesn't
 * touch ffprobe at all so the mock doesn't affect those assertions.
 *
 * NOTE on mock strategy:
 *   `fluent-ffmpeg` exports `ffprobe` as a non-configurable property, which
 *   means `jest.spyOn(ffmpeg, 'ffprobe')` throws "Cannot redefine property".
 *   The standard workaround is to mock the entire module with `jest.mock()`,
 *   which replaces the module in the require cache before any import sees it.
 */

import { Readable } from 'stream';
import { VideoProbeProcessor } from '../../../src/storage/processing/processors/video-probe.processor';
import { bufferToStream } from '../../fixtures/media/image-fixtures';
import type * as FfmpegType from 'fluent-ffmpeg';

// ---------------------------------------------------------------------------
// Module-level mock — must be at the top level so Jest hoists it
// ---------------------------------------------------------------------------

const mockFfprobeFn = jest.fn();

jest.mock('fluent-ffmpeg', () => {
  const original = jest.requireActual<typeof FfmpegType>('fluent-ffmpeg');
  return {
    ...original,
    ffprobe: (...args: any[]) => mockFfprobeFn(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObject(mimeType = 'video/mp4') {
  return {
    id: 'obj-vid-001',
    mimeType,
    name: 'clip.mp4',
    size: BigInt(0),
    storageKey: 'key',
    storageProvider: 's3',
    bucket: 'bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

function makeGetStream(buf = Buffer.from('fake-video')): () => Promise<Readable> {
  return () => Promise.resolve(bufferToStream(buf));
}

function makeSyntheticProbeData(
  overrides: Partial<FfmpegType.FfprobeData> = {},
): FfmpegType.FfprobeData {
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        index: 0,
      } as any,
      {
        codec_type: 'audio',
        codec_name: 'aac',
        index: 1,
      } as any,
    ],
    format: {
      duration: 12.4,
      filename: '/tmp/fake',
      nb_streams: 2,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size: '102400',
      bit_rate: '0',
    } as any,
    chapters: [],
    ...overrides,
  };
}

/** Configures mockFfprobeFn to invoke its last argument (callback) with the given data. */
function setupFfprobeSuccess(data: FfmpegType.FfprobeData) {
  mockFfprobeFn.mockImplementation((_path: string, callback: any) => {
    callback(null, data);
  });
}

function setupFfprobeError(err: Error) {
  mockFfprobeFn.mockImplementation((_path: string, callback: any) => {
    callback(err, undefined);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoProbeProcessor', () => {
  let processor: VideoProbeProcessor;

  beforeEach(() => {
    processor = new VideoProbeProcessor();
    mockFfprobeFn.mockReset();
    setupFfprobeSuccess(makeSyntheticProbeData());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('processor identity', () => {
    it('should have name "video-probe"', () => {
      expect(processor.name).toBe('video-probe');
    });

    it('should have priority 20', () => {
      expect(processor.priority).toBe(20);
    });
  });

  describe('canProcess', () => {
    it('should return true for video/mp4', () => {
      expect(processor.canProcess(makeObject('video/mp4'))).toBe(true);
    });

    it('should return true for video/quicktime', () => {
      expect(processor.canProcess(makeObject('video/quicktime'))).toBe(true);
    });

    it('should return true for video/x-msvideo (AVI)', () => {
      expect(processor.canProcess(makeObject('video/x-msvideo'))).toBe(true);
    });

    it('should return false for image/jpeg', () => {
      expect(processor.canProcess(makeObject('image/jpeg'))).toBe(false);
    });

    it('should return false for image/png', () => {
      expect(processor.canProcess(makeObject('image/png'))).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(processor.canProcess(makeObject('application/pdf'))).toBe(false);
    });

    it('should return false for audio/mpeg', () => {
      expect(processor.canProcess(makeObject('audio/mpeg'))).toBe(false);
    });
  });

  describe('process — with synthetic ffprobe data', () => {
    it('should return success:true', async () => {
      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should map duration to durationMs (rounds to integer ms)', async () => {
      // synthetic data has duration 12.4 s → 12400 ms
      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.durationMs).toBe(12400);
    });

    it('should extract video stream width', async () => {
      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.width).toBe(1920);
    });

    it('should extract video stream height', async () => {
      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.height).toBe(1080);
    });

    it('should extract codec name', async () => {
      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.codec).toBe('h264');
    });

    it('should use the first stream with codec_type === "video"', async () => {
      setupFfprobeSuccess(makeSyntheticProbeData({
        streams: [
          { codec_type: 'audio', index: 0 } as any,
          { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, index: 1 } as any,
        ],
      }));

      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.codec).toBe('hevc');
      expect(result.metadata?.width).toBe(3840);
      expect(result.metadata?.height).toBe(2160);
    });

    it('should round fractional durations correctly', async () => {
      setupFfprobeSuccess(makeSyntheticProbeData({ format: { duration: 3.567 } as any }));

      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.metadata?.durationMs).toBe(3567);
    });
  });

  describe('process — ffprobe error', () => {
    it('should return success:false when ffprobe reports an error', async () => {
      setupFfprobeError(new Error('ffprobe: no such file'));

      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('process — missing optional fields', () => {
    it('should omit durationMs when format.duration is absent', async () => {
      setupFfprobeSuccess(makeSyntheticProbeData({
        streams: [{ codec_type: 'video', codec_name: 'vp9', width: 640, height: 480, index: 0 } as any],
        format: {} as any,
      }));

      const result = await processor.process(makeObject(), makeGetStream());
      expect(result.success).toBe(true);
      expect(result.metadata?.durationMs).toBeUndefined();
      expect(result.metadata?.codec).toBe('vp9');
    });
  });
});
