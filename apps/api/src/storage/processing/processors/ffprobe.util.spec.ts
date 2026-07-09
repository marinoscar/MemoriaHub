/**
 * Unit tests — ffprobe.util (probeVideoFileWithTimeout)
 *
 * `fluent-ffmpeg` exports `ffprobe` as a non-configurable property, so
 * `jest.spyOn(ffmpeg, 'ffprobe')` throws "Cannot redefine property" — the
 * whole module is mocked instead, mirroring the approach already used in
 * test/storage/processing/video-probe.processor.spec.ts.
 *
 * Scope: only probeVideoFileWithTimeout's race/timeout behavior.
 * probeVideoFile's plain callback wiring and extractContainerMetadata's
 * mapping logic are already exercised end-to-end via
 * VideoProbeProcessor's tests, so they are not duplicated here.
 */

import { probeVideoFileWithTimeout } from './ffprobe.util';
import type * as FfmpegType from 'fluent-ffmpeg';

const mockFfprobeFn = jest.fn();

jest.mock('fluent-ffmpeg', () => {
  const original = jest.requireActual<typeof FfmpegType>('fluent-ffmpeg');
  return {
    ...original,
    ffprobe: (...args: any[]) => mockFfprobeFn(...args),
  };
});

describe('probeVideoFileWithTimeout', () => {
  beforeEach(() => {
    mockFfprobeFn.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves with the probe data when ffprobe finishes before the timeout', async () => {
    const fakeData = {
      streams: [],
      format: {},
      chapters: [],
    } as unknown as FfmpegType.FfprobeData;
    mockFfprobeFn.mockImplementation((_path: string, callback: any) => {
      // Resolve asynchronously so the Promise.race is genuinely exercised
      // rather than short-circuiting on a synchronous callback.
      setImmediate(() => callback(null, fakeData));
    });

    const result = await probeVideoFileWithTimeout('/tmp/fake.mp4', 5000);
    expect(result).toBe(fakeData);
  });

  it('clears the timeout when the probe wins the race (no dangling timer)', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const fakeData = {
      streams: [],
      format: {},
      chapters: [],
    } as unknown as FfmpegType.FfprobeData;
    mockFfprobeFn.mockImplementation((_path: string, callback: any) => {
      setImmediate(() => callback(null, fakeData));
    });

    await probeVideoFileWithTimeout('/tmp/fake.mp4', 5000);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('also clears the timeout when the probe errors before the timeout (not just on success)', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    mockFfprobeFn.mockImplementation((_path: string, callback: any) => {
      setImmediate(() => callback(new Error('ffprobe: no such file'), undefined));
    });

    await expect(probeVideoFileWithTimeout('/tmp/missing.mp4', 5000)).rejects.toThrow(
      'ffprobe: no such file',
    );
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects with "ffprobe timed out after <ms>ms" when the probe never calls back', async () => {
    // Never invoke the callback — simulates a hung ffprobe process on a
    // corrupt/truncated container (fluent-ffmpeg exposes no process handle
    // to kill, per the JSDoc on probeVideoFileWithTimeout).
    mockFfprobeFn.mockImplementation(() => {});

    jest.useFakeTimers();
    const probePromise = probeVideoFileWithTimeout('/tmp/hung.mp4', 5000);
    // Attach a handler immediately so the pending rejection is never
    // "unhandled" while fake timers are advanced below.
    const rejectionCheck = probePromise.catch((e: unknown) => e);

    await jest.advanceTimersByTimeAsync(5000);
    const err = await rejectionCheck;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('ffprobe timed out after 5000ms');
  });
});
