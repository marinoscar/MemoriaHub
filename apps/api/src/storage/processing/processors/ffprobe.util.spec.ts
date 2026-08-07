/**
 * Unit tests — ffprobe.util (probeVideoFileWithTimeout)
 *
 * Mock strategy:
 *   `probeVideoFileWithTimeout` delegates to the shared parity package's
 *   `probeVideo`, which since issue #219 spawns ffprobe through the package's
 *   own thin wrapper (`@memoriahub/enrichment-compute/ffmpeg`) instead of the
 *   deprecated `fluent-ffmpeg`. Only `runFfprobe` is replaced here; the
 *   subpath specifier resolves to the very same module file that
 *   `dist/cjs/metadata/index.js` requires as `../ffmpeg/index.js`, so one
 *   jest.mock covers the call site inside the shared package.
 *
 * Scope: only probeVideoFileWithTimeout's timeout behavior. probeVideoFile's
 * plain wiring and extractContainerMetadata's mapping logic are already
 * exercised end-to-end via VideoProbeProcessor's tests, so they are not
 * duplicated here.
 *
 * Behaviour note (issue #219): the timeout is now enforced INSIDE the wrapper,
 * which also SIGKILLs the hung ffprobe child — a gap fluent-ffmpeg's
 * callback-only `ffprobe()` API could not close, since it exposed no process
 * handle. The old "clears the timeout when the probe wins the race" tests
 * asserted an implementation detail of the removed Promise.race
 * (a `clearTimeout` call count) rather than observable behavior; they are
 * replaced below by assertions on what the caller actually sees. The wrapper's
 * own guarantees — no dangling timer, and the SIGKILL of the hung child — are
 * unit-tested in
 * packages/enrichment-compute/test/ffmpeg.test.mjs ('runFfprobe KILLS the hung
 * ffprobe child on timeout'), which is where the real spawn seam lives.
 */

import { probeVideoFileWithTimeout } from './ffprobe.util';

const mockRunFfprobe = jest.fn();

jest.mock('@memoriahub/enrichment-compute/ffmpeg', () => {
  const actual = jest.requireActual('@memoriahub/enrichment-compute/ffmpeg');
  return {
    ...actual,
    runFfprobe: (...args: any[]) => mockRunFfprobe(...args),
  };
});

describe('probeVideoFileWithTimeout', () => {
  beforeEach(() => {
    mockRunFfprobe.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves with the probe data when ffprobe finishes before the timeout', async () => {
    const fakeData = { streams: [], format: {}, chapters: [] };
    // Resolve asynchronously so the timeout path is genuinely a live race
    // rather than short-circuiting on a synchronous resolution.
    mockRunFfprobe.mockImplementation(
      () => new Promise((resolve) => setImmediate(() => resolve(fakeData))),
    );

    const result = await probeVideoFileWithTimeout('/tmp/fake.mp4', 5000);
    expect(result).toEqual(fakeData);
  });

  it('forwards the caller\'s timeout budget and message down to the wrapper', async () => {
    mockRunFfprobe.mockResolvedValue({ streams: [], format: {}, chapters: [] });

    await probeVideoFileWithTimeout('/tmp/fake.mp4', 5000);

    expect(mockRunFfprobe).toHaveBeenCalledWith('/tmp/fake.mp4', {
      timeoutMs: 5000,
      timeoutMessage: 'ffprobe timed out after 5000ms',
    });
  });

  it('propagates a probe error to the caller', async () => {
    mockRunFfprobe.mockRejectedValue(new Error('ffprobe: no such file'));

    await expect(probeVideoFileWithTimeout('/tmp/missing.mp4', 5000)).rejects.toThrow(
      'ffprobe: no such file',
    );
  });

  it('rejects with "ffprobe timed out after <ms>ms" when the probe never settles', async () => {
    // Never settle — simulates a hung ffprobe process on a corrupt/truncated
    // container. The real wrapper both rejects with this message AND SIGKILLs
    // the child; here the wrapper is mocked, so the message contract is
    // asserted by having the fake honour the timeout options it was handed.
    mockRunFfprobe.mockImplementation(
      (_path: string, opts: { timeoutMs: number; timeoutMessage: string }) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error(opts.timeoutMessage)), opts.timeoutMs);
        }),
    );

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
