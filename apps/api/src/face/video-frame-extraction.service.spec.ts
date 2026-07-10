/**
 * Unit tests for VideoFrameExtractionService — frame-sampling math.
 *
 * The core public API is `computeSeekTimestamps` (module-private pure function),
 * which is exercised through `VideoFrameExtractionService.extractFrames` by
 * mocking fluent-ffmpeg so no real video decoding happens.
 *
 * `extractFrames`/`extractFramesAt` take an already-materialized video file
 * path (not a Buffer) — the caller owns downloading/cleaning up the input
 * file. Tests pass a fake path string; no input file is ever read since
 * fluent-ffmpeg is mocked.
 *
 * We mock:
 *  - fluent-ffmpeg    — the ffmpeg binary call chain (seekInput/frames/output/run)
 *  - fs/promises      — readFile / unlink so no (output frame) temp files are created
 *
 * What we test:
 *  1. A 1-hour video at the default cap of 60 → ~60 evenly spaced timestamps ≤ duration.
 *  2. A 30-second clip at a 5-second interval → ~6 timestamps.
 *  3. A zero-duration (durationMs=0) video → single fallback frame at 0 ms.
 *  4. A very-short video (durationMs=50, i.e. < 100 ms threshold) → single frame at 0.
 *  5. A video shorter than interval/2 → single poster frame.
 *  6. maxFrames cap is respected even when there is room for more timestamps.
 *  7. Mid-interval sampling: first timestamp is interval/2, not 0.
 *  8. All timestamps are strictly less than durationSec.
 */

import { VideoFrameExtractionService } from './video-frame-extraction.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fluent-ffmpeg before importing the service so Jest intercepts the module
jest.mock('fluent-ffmpeg', () => {
  // Return a jest function that, when called, returns a fluent API object.
  // Every chained method returns "this" so the chain terminates at .run().
  const chain = {
    seekInput: jest.fn().mockReturnThis(),
    frames: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation((event, cb) => {
      // Immediately fire 'end' so extractFrame resolves
      if (event === 'end') cb();
      return chain;
    }),
    run: jest.fn().mockReturnThis(),
  };
  const ffmpegMock = jest.fn().mockReturnValue(chain);
  return { default: ffmpegMock, __esModule: true, ...ffmpegMock };
});

// Mock fs/promises so we never touch the real filesystem
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn().mockResolvedValue(Buffer.from('fake-jpeg')),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

/** Fake already-materialized video path — no input file is ever read. */
const FAKE_VIDEO_PATH = '/tmp/fake-video-input.mp4';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Invoke extractFrames with given opts and return the timestamps that came back. */
async function getTimestampsMs(
  durationMs: number | null | undefined,
  sampleIntervalSeconds: number,
  maxFrames: number,
): Promise<number[]> {
  const svc = new VideoFrameExtractionService();
  const frames = await svc.extractFrames(FAKE_VIDEO_PATH, {
    durationMs,
    sampleIntervalSeconds,
    maxFrames,
  });
  return frames.map((f) => f.timestampMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoFrameExtractionService — timestamp computation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the fluent-ffmpeg chain so 'end' fires for every frame
    const ffmpeg = require('fluent-ffmpeg');
    const chain = {
      seekInput: jest.fn().mockReturnThis(),
      frames: jest.fn().mockReturnThis(),
      output: jest.fn().mockReturnThis(),
      on: jest.fn().mockImplementation((event, cb) => {
        if (event === 'end') cb();
        return chain;
      }),
      run: jest.fn().mockReturnThis(),
    };
    ffmpeg.mockReturnValue(chain);
  });

  // -----------------------------------------------------------------------
  // 1. 1-hour video at cap 60 → ≤ 60 timestamps, all < duration, evenly spaced
  // -----------------------------------------------------------------------
  describe('1-hour video at maxFrames=60', () => {
    const ONE_HOUR_MS = 3600 * 1000;

    it('produces exactly 60 timestamps', async () => {
      const ts = await getTimestampsMs(ONE_HOUR_MS, 5, 60);
      expect(ts).toHaveLength(60);
    });

    it('all timestamps are less than the video duration', async () => {
      const ts = await getTimestampsMs(ONE_HOUR_MS, 5, 60);
      const ONE_HOUR_SEC = 3600;
      for (const ms of ts) {
        expect(ms / 1000).toBeLessThan(ONE_HOUR_SEC);
      }
    });

    it('timestamps are in ascending order', async () => {
      const ts = await getTimestampsMs(ONE_HOUR_MS, 5, 60);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeGreaterThan(ts[i - 1]);
      }
    });

    it('timestamps are evenly spaced at ~60 s apart (interval = max(5, 3600/60) = 60)', async () => {
      const ts = await getTimestampsMs(ONE_HOUR_MS, 5, 60);
      // Expected interval = max(5, 3600/60) = 60 s → 60000 ms
      const expectedIntervalMs = 60000;
      // Allow 1 ms rounding tolerance
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i] - ts[i - 1]).toBeCloseTo(expectedIntervalMs, -1);
      }
    });

    it('first timestamp is at interval/2 (mid-interval, not 0)', async () => {
      const ts = await getTimestampsMs(ONE_HOUR_MS, 5, 60);
      // interval = 60 s → first frame at 30 s = 30000 ms
      expect(ts[0]).toBeCloseTo(30000, -1);
    });
  });

  // -----------------------------------------------------------------------
  // 2. 30-second clip at 5-second interval → ~6 timestamps
  // -----------------------------------------------------------------------
  describe('30-second clip at 5 s interval', () => {
    const THIRTY_SEC_MS = 30 * 1000;

    it('produces 6 timestamps', async () => {
      const ts = await getTimestampsMs(THIRTY_SEC_MS, 5, 60);
      expect(ts).toHaveLength(6);
    });

    it('all timestamps are less than 30 s', async () => {
      const ts = await getTimestampsMs(THIRTY_SEC_MS, 5, 60);
      for (const ms of ts) {
        expect(ms).toBeLessThan(THIRTY_SEC_MS);
      }
    });

    it('first timestamp is 2500 ms (5 s interval / 2)', async () => {
      const ts = await getTimestampsMs(THIRTY_SEC_MS, 5, 60);
      expect(ts[0]).toBe(2500);
    });

    it('timestamps are spaced 5000 ms apart', async () => {
      const ts = await getTimestampsMs(THIRTY_SEC_MS, 5, 60);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i] - ts[i - 1]).toBe(5000);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Zero-duration video → single fallback frame at 0 ms
  // -----------------------------------------------------------------------
  describe('zero-duration video (durationMs = 0)', () => {
    it('returns exactly one timestamp', async () => {
      const ts = await getTimestampsMs(0, 5, 60);
      expect(ts).toHaveLength(1);
    });

    it('the single timestamp is 0 ms', async () => {
      const ts = await getTimestampsMs(0, 5, 60);
      expect(ts[0]).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Missing/undefined durationMs → single fallback frame
  // -----------------------------------------------------------------------
  describe('undefined / null durationMs', () => {
    it('returns one timestamp at 0 for undefined durationMs', async () => {
      const ts = await getTimestampsMs(undefined, 5, 60);
      expect(ts).toHaveLength(1);
      expect(ts[0]).toBe(0);
    });

    it('returns one timestamp at 0 for null durationMs', async () => {
      const ts = await getTimestampsMs(null, 5, 60);
      expect(ts).toHaveLength(1);
      expect(ts[0]).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Very short video (< 100 ms threshold) → single poster frame
  // -----------------------------------------------------------------------
  describe('very short video (durationMs = 50 ms)', () => {
    it('returns a single poster-frame timestamp at 0', async () => {
      const ts = await getTimestampsMs(50, 5, 60);
      expect(ts).toHaveLength(1);
      expect(ts[0]).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. maxFrames cap is respected
  // -----------------------------------------------------------------------
  describe('maxFrames cap', () => {
    it('does not exceed maxFrames=3 on a 60-second video at 5 s interval', async () => {
      const ts = await getTimestampsMs(60 * 1000, 5, 3);
      expect(ts.length).toBeLessThanOrEqual(3);
    });

    it('with maxFrames=1, returns exactly one timestamp', async () => {
      const ts = await getTimestampsMs(60 * 1000, 5, 1);
      expect(ts).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Interval expansion when video is long relative to maxFrames
  // -----------------------------------------------------------------------
  describe('interval expansion (durationSec / maxFrames > sampleIntervalSeconds)', () => {
    it('spreads frames evenly across a 10-minute video with maxFrames=3', async () => {
      // durationSec = 600, maxFrames = 3, sampleIntervalSec = 5
      // Effective interval = max(5, 600/3) = 200 s
      // Timestamps: 100, 300, 500 s (in ms: 100000, 300000, 500000)
      const ts = await getTimestampsMs(600 * 1000, 5, 3);
      expect(ts).toHaveLength(3);
      expect(ts[0]).toBeCloseTo(100000, -1); // 100 s
      expect(ts[1]).toBeCloseTo(300000, -1); // 300 s
      expect(ts[2]).toBeCloseTo(500000, -1); // 500 s
    });
  });

  // -----------------------------------------------------------------------
  // 8. Each ExtractedFrame includes the correct timestampMs
  // -----------------------------------------------------------------------
  describe('ExtractedFrame.timestampMs', () => {
    it('matches the computed seek timestamp (rounded to ms)', async () => {
      const svc = new VideoFrameExtractionService();
      // 30 s video at 5 s interval → timestamps: 2500, 7500, 12500, 17500, 22500, 27500 ms
      const frames = await svc.extractFrames(FAKE_VIDEO_PATH, {
        durationMs: 30000,
        sampleIntervalSeconds: 5,
        maxFrames: 60,
      });
      expect(frames.map((f) => f.timestampMs)).toEqual([
        2500, 7500, 12500, 17500, 22500, 27500,
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 9. A video whose duration equals exactly interval/2 → single poster frame
  //    (no mid-interval timestamp can fit before durationSec)
  // -----------------------------------------------------------------------
  describe('video whose duration < interval', () => {
    it('returns a single frame when durationMs is well below sampleIntervalSeconds', async () => {
      // durationMs = 2000 ms (2 s), interval = 5 s → interval/2 = 2.5 s > 2 s → no ts fits
      // Falls back to the "empty timestamps → push 0" edge case
      const ts = await getTimestampsMs(2000, 5, 60);
      expect(ts).toHaveLength(1);
      expect(ts[0]).toBe(0);
    });
  });
});
