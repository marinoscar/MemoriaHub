/**
 * Unit tests for @memoriahub/enrichment-compute/video — extractPosterFrame.
 *
 * This is the shared three-attempt poster-frame fallback ladder (seek 1s →
 * seek 0s → ffmpeg `thumbnail` filter) used identically by the server's
 * ThumbnailProcessor.processVideo and a distributed worker node's thumbnail
 * compute module (apps/cli/src/node/compute/thumbnail.ts). Before this file
 * existed, this behavior only had test coverage indirectly through
 * apps/api/test/storage/processing/thumbnail.processor.spec.ts's
 * 'extractFrame — timeout handling' describe block, which called a *private*
 * ThumbnailProcessor method that no longer exists now that the logic moved
 * here — those two tests are ported below, adapted to the public
 * extractPosterFrame() surface (whole 3-attempt ladder rather than one
 * seekSecs value at a time).
 *
 * MOCK STRATEGY — the ffmpeg spawn seam:
 *
 * `extractPosterFrame` shells out through the package's own thin ffmpeg
 * wrapper (src/ffmpeg/index.ts), which replaced the deprecated fluent-ffmpeg
 * dependency in issue #219. These tests used to pre-seed the CJS
 * `require.cache` with a fake `fluent-ffmpeg` module — a technique that no
 * longer applies now that no such module exists, and that could not have been
 * pointed at `node:child_process` anyway (a builtin).
 *
 * Instead the wrapper exposes an explicit `__setSpawnForTests()` seam, and
 * this file installs a fake `spawn` returning a scripted EventEmitter that
 * quacks like a ChildProcess. Every assertion below is preserved verbatim in
 * intent; the per-attempt `seekSecs` / `usedThumbnailFilter` facts previously
 * read off `.seekInput()` / `.videoFilters()` calls are now DERIVED FROM THE
 * REAL ARGV the wrapper builds, which makes these tests a second (indirect)
 * parity guard on top of test/ffmpeg.test.mjs's explicit argv assertions.
 *
 * These tests import '@memoriahub/enrichment-compute/video' via the package's
 * `exports` map, so they exercise the BUILT dist/esm output — run `npm run
 * build` after editing src/video/index.ts before running `npm test`. The seam
 * is imported from the '/ffmpeg' subpath, which resolves to the SAME module
 * instance dist/esm/video/index.js imports as '../ffmpeg/index.js' (Node's ESM
 * cache is keyed by resolved URL), so installing the fake there really does
 * intercept the extraction path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { __setSpawnForTests } = await import('@memoriahub/enrichment-compute/ffmpeg');

/**
 * Parse the facts a test cares about back out of a real ffmpeg argv:
 *   ['-ss', '<s>', '-i', <in>, '-y', '-vframes', '1', <out>]
 *   ['-i', <in>, '-y', '-vframes', '1', '-filter:v', 'thumbnail', <out>]
 */
function describeArgs(args) {
  const ssIdx = args.indexOf('-ss');
  const filterIdx = args.indexOf('-filter:v');
  return {
    inputPath: args[args.indexOf('-i') + 1],
    outputPath: args[args.length - 1],
    seekSecs: ssIdx === -1 ? null : Number(args[ssIdx + 1]),
    usedThumbnailFilter: filterIdx !== -1 && args[filterIdx + 1] === 'thumbnail',
    args,
  };
}

/**
 * Install a fake `spawn` for the duration of one test.
 *
 * `attempts` is an array of per-call behavior descriptors, consumed in order
 * — index 0 drives the ladder's first attempt (1s seek), index 1 the second
 * (0s seek), index 2 the third (thumbnail filter, no seek). Each descriptor:
 *   { kind: 'success', bytes? }  — writes `bytes` (default non-empty) to the
 *                                  output path, then exits 0.
 *   { kind: 'empty' }            — exits 0 after writing a zero-byte file —
 *                                   exercises the assertNonEmptyFile fallback.
 *   { kind: 'error', message? }  — exits 1 with `message` on stderr, which the
 *                                   wrapper turns into an Error.
 *   { kind: 'hang', onKill? }    — never exits on its own; `onKill(child)`
 *                                  runs when the wrapper SIGKILLs it (used to
 *                                  simulate the late 'error'/'close' a killed
 *                                  ffmpeg still emits).
 *
 * Returns { restore, calls } — `calls` records what each invocation actually
 * did (derived seek value, kill signals received) for assertions.
 */
function installFakeFfmpeg(attempts) {
  const calls = [];
  let callIndex = 0;

  __setSpawnForTests((_command, args) => {
    const idx = callIndex++;
    const behavior = attempts[idx] ?? { kind: 'error', message: 'no scripted behavior for this attempt' };

    const call = { ...describeArgs([...args]), killSignals: [] };
    calls.push(call);

    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.stdin = new EventEmitter();
    child.kill = (signal) => {
      call.killSignals.push(signal);
      behavior.onKill?.(child);
      return true;
    };

    const exit = (code, stderr) => {
      child.stdout.push(null);
      if (stderr) child.stderr.push(stderr);
      child.stderr.push(null);
      child.emit('close', code, null);
    };

    switch (behavior.kind) {
      case 'success': {
        const bytes = behavior.bytes ?? Buffer.from(`fake-frame-${idx}`);
        fs.writeFile(call.outputPath, bytes).then(() => exit(0));
        break;
      }
      case 'empty': {
        fs.writeFile(call.outputPath, Buffer.alloc(0)).then(() => exit(0));
        break;
      }
      case 'error': {
        setImmediate(() => exit(1, behavior.message ?? 'ffmpeg: mock error'));
        break;
      }
      case 'hang': {
        // Never settles on its own — only a real timeout (or an
        // explicitly-scripted onKill side effect) can move this along.
        break;
      }
      default:
        throw new Error(`unknown fake ffmpeg behavior kind: ${behavior.kind}`);
    }

    return child;
  });

  return {
    calls,
    restore() {
      __setSpawnForTests(null);
    },
  };
}

function fakeVideoPath() {
  return join(tmpdir(), `memoriaHub-test-video-${randomUUID()}.mp4`);
}

// ---------------------------------------------------------------------------
// Fallback ladder success
// ---------------------------------------------------------------------------

test('extractPosterFrame succeeds on the first attempt (1s seek) when it produces a non-empty frame', async () => {
  const { calls, restore } = installFakeFfmpeg([{ kind: 'success', bytes: Buffer.from('attempt-1-bytes') }]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');
    const buf = await extractPosterFrame(fakeVideoPath());

    assert.equal(buf.toString(), 'attempt-1-bytes');
    assert.equal(calls.length, 1, 'only the first attempt should have run');
    assert.equal(calls[0].seekSecs, 1, 'first attempt should seek to 1s');
  } finally {
    restore();
  }
});

test('falls back to the next attempt when an earlier attempt errors, and returns the winning attempt\'s bytes', async () => {
  const { calls, restore } = installFakeFfmpeg([
    { kind: 'error', message: 'ffmpeg: seek past end of stream' },
    { kind: 'success', bytes: Buffer.from('attempt-2-bytes') },
  ]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');
    const buf = await extractPosterFrame(fakeVideoPath());

    assert.equal(buf.toString(), 'attempt-2-bytes');
    assert.equal(calls.length, 2, 'ladder should have fallen through to the second attempt');
    assert.equal(calls[0].seekSecs, 1, 'first attempt seeks to 1s');
    assert.equal(calls[1].seekSecs, 0, 'second attempt seeks to 0s');
  } finally {
    restore();
  }
});

test('falls all the way to the thumbnail-filter attempt (no seek) when both seek attempts fail', async () => {
  const { calls, restore } = installFakeFfmpeg([
    { kind: 'error', message: 'attempt 1 failed' },
    { kind: 'error', message: 'attempt 2 failed' },
    { kind: 'success', bytes: Buffer.from('attempt-3-bytes') },
  ]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');
    const buf = await extractPosterFrame(fakeVideoPath());

    assert.equal(buf.toString(), 'attempt-3-bytes');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].seekSecs, null, 'third attempt does not seek');
    assert.equal(calls[2].usedThumbnailFilter, true, 'third attempt uses the thumbnail filter');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Non-empty-file validation
// ---------------------------------------------------------------------------

test('treats a zero-byte output file as a failed attempt (ffmpeg exiting 0 without writing a frame)', async () => {
  const { calls, restore } = installFakeFfmpeg([
    { kind: 'empty' }, // ffmpeg "succeeds" (fires 'end') but writes nothing
    { kind: 'success', bytes: Buffer.from('real-frame-bytes') },
  ]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');
    const buf = await extractPosterFrame(fakeVideoPath());

    assert.equal(buf.toString(), 'real-frame-bytes', 'the empty attempt must not be accepted as a win');
    assert.equal(calls.length, 2, 'ladder must fall through past the empty-output attempt');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// All attempts exhausted
// ---------------------------------------------------------------------------

test('rejects with the last attempt\'s error when all three attempts fail', async () => {
  const { calls, restore } = installFakeFfmpeg([
    { kind: 'error', message: 'attempt 1: bad seek' },
    { kind: 'error', message: 'attempt 2: bad seek' },
    { kind: 'error', message: 'attempt 3: thumbnail filter failed' },
  ]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');

    await assert.rejects(
      () => extractPosterFrame(fakeVideoPath()),
      (err) => {
        assert.ok(err instanceof Error);
        // The wrapper wraps a non-zero ffmpeg exit as
        // `ffmpeg exited with code 1: <stderr>` — the same shape fluent-ffmpeg
        // produced for a real failing binary (its `extractError` + "exited
        // with code" message). What matters here is that the surfaced error is
        // the LAST attempt's, not attempt 1's or 2's.
        assert.match(err.message, /attempt 3: thumbnail filter failed/);
        assert.doesNotMatch(err.message, /attempt 1|attempt 2/);
        return true;
      },
    );
    assert.equal(calls.length, 3, 'all three attempts must have been tried');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Timeout / SIGKILL handling (ported from the removed
// ThumbnailProcessor#extractFrame — timeout handling describe block)
// ---------------------------------------------------------------------------

test('kills a hung ffmpeg process with SIGKILL on every attempt and ultimately rejects with a timeout message', async () => {
  const { calls, restore } = installFakeFfmpeg([{ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }]);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');

    await assert.rejects(
      () => extractPosterFrame(fakeVideoPath(), { ffmpegTimeoutMs: 30 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /timed out after 30ms/);
        return true;
      },
    );

    assert.equal(calls.length, 3, 'every rung of the ladder should have been attempted and timed out');
    for (const call of calls) {
      assert.deepEqual(call.killSignals, ['SIGKILL']);
    }
  } finally {
    restore();
  }
});

test('settles only once: a late "error" event fired as a side effect of kill() does not throw and does not derail the ladder', async () => {
  const { calls, restore } = installFakeFfmpeg([
    {
      kind: 'hang',
      // Simulate the real-world race: SIGKILL doesn't synchronously stop the
      // process from later emitting its own 'error' event. This must be a
      // harmless no-op thanks to the settled guard inside
      // extractPosterFrameAttempt — it must NOT throw, and must NOT flip the
      // outcome of the (already-timed-out) first attempt.
      onKill: (child) => {
        setTimeout(() => {
          assert.doesNotThrow(() => {
            child.emit('error', new Error('late ffmpeg process error'));
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit('close', null, 'SIGKILL');
          });
        }, 0);
      },
    },
    { kind: 'success', bytes: Buffer.from('attempt-2-bytes') },
  ]);

  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { extractPosterFrame } = await import('@memoriahub/enrichment-compute/video');

    const buf = await extractPosterFrame(fakeVideoPath(), { ffmpegTimeoutMs: 30 });

    assert.equal(buf.toString(), 'attempt-2-bytes', 'the ladder should fall through to attempt 2 normally');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].killSignals, ['SIGKILL']);

    // Give the scheduled late 'error' callback (setTimeout 0, fired from
    // inside kill()) a chance to run before asserting no unhandled rejection
    // was recorded.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandledRejections, [], 'the late error event must not produce an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    restore();
  }
});
