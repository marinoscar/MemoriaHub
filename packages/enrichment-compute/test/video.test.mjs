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
 * MOCK STRATEGY — fluent-ffmpeg:
 *
 * `loadFfmpeg()` inside src/video/index.ts loads fluent-ffmpeg lazily via
 * `nodeRequire('fluent-ffmpeg')` (a real CJS `require` from node-require.cts,
 * see that file's header comment). This package's test convention is Node's
 * built-in test runner (`node --test`, no Jest, no `ts-jest`/`babel-jest`
 * module-mock hoisting available), and mocking an ESM import isn't directly
 * possible without extra flags.
 *
 * `node:test`'s `mock.module()` API would be the modern, built-in answer, but
 * it requires the `--experimental-test-module-mocks` flag on this Node
 * version (confirmed by hand: `mock.module` is undefined without the flag),
 * and this package's `test` script (`node --test`) does not pass it — adding
 * it here would mean changing the shared script for every other test file in
 * this directory, out of scope for this change.
 *
 * Instead this file mocks fluent-ffmpeg at the CJS `require.cache` level:
 * `fluent-ffmpeg` is a plain CJS package with exactly one copy in this
 * monorepo's (hoisted) node_modules, so `createRequire(import.meta.url)
 * .resolve('fluent-ffmpeg')` resolves to the SAME absolute path that
 * node-require.cts's `require('fluent-ffmpeg')` call will resolve to (Node's
 * CJS module cache is a single process-wide registry keyed by resolved
 * filename, not per-`require`-instance) — verified by hand that both resolve
 * to `<repo>/node_modules/fluent-ffmpeg/index.js`. Pre-seeding
 * `require.cache[thatPath]` with a fake module object before `loadFfmpeg()`
 * runs means the real `require('fluent-ffmpeg')` call returns the fake
 * instead of ever touching the real package (which would try to invoke a
 * real `ffmpeg` binary). No source changes to extractPosterFrame() were made
 * to support this — no test-only injection seam was added, per the task's
 * explicit instruction not to refactor the public signature.
 *
 * These tests import '@memoriahub/enrichment-compute/video' via the package's
 * `exports` map, so they exercise the BUILT dist/esm output — run `npm run
 * build` after editing src/video/index.ts before running `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const FFMPEG_PATH = require.resolve('fluent-ffmpeg');

/**
 * Install a fake fluent-ffmpeg module into the shared CJS require cache for
 * the duration of one test, restoring whatever was cached before (nothing,
 * in practice, since nothing else in this suite requires the real package).
 *
 * `attempts` is an array of per-call behavior descriptors, consumed in order
 * — index 0 drives the ladder's first attempt (1s seek), index 1 the second
 * (0s seek), index 2 the third (thumbnail filter, no seek). Each descriptor:
 *   { kind: 'success', bytes? }  — writes `bytes` (default non-empty) to the
 *                                  output path, then fires 'end'.
 *   { kind: 'empty' }            — fires 'end' WITHOUT writing anything (or
 *                                   writes a zero-byte file) — exercises the
 *                                   assertNonEmptyFile fallback path.
 *   { kind: 'error', message? }  — fires 'error' with an Error.
 *   { kind: 'hang', onKill? }    — never fires 'end'/'error' on its own;
 *                                  `onKill(cmd)` runs when .kill() is called
 *                                  (used to simulate a late 'error' event
 *                                  fired as a side-effect of SIGKILL).
 *
 * Returns { restore, calls } — `calls` records what each invocation actually
 * did (seek value used, kill signals received) for assertions.
 */
function installFakeFfmpeg(attempts) {
  const previous = require.cache[FFMPEG_PATH];
  const calls = [];
  let callIndex = 0;

  function factory(inputPath) {
    const idx = callIndex++;
    const behavior = attempts[idx] ?? { kind: 'error', message: 'no scripted behavior for this attempt' };
    const call = { inputPath, seekSecs: null, usedThumbnailFilter: false, killSignals: [] };
    calls.push(call);

    let endCb = null;
    let errorCb = null;
    let outputPath = null;

    const cmd = {
      seekInput(seconds) {
        call.seekSecs = seconds;
        return cmd;
      },
      videoFilters(filter) {
        if (filter === 'thumbnail') call.usedThumbnailFilter = true;
        return cmd;
      },
      frames() {
        return cmd;
      },
      output(path) {
        outputPath = path;
        return cmd;
      },
      on(event, cb) {
        if (event === 'end') endCb = cb;
        if (event === 'error') errorCb = cb;
        return cmd;
      },
      kill(signal) {
        call.killSignals.push(signal);
        behavior.onKill?.({ errorCb: (err) => errorCb?.(err) });
      },
      run() {
        switch (behavior.kind) {
          case 'success': {
            const bytes = behavior.bytes ?? Buffer.from(`fake-frame-${idx}`);
            fs.writeFile(outputPath, bytes).then(() => endCb?.());
            break;
          }
          case 'empty': {
            fs.writeFile(outputPath, Buffer.alloc(0)).then(() => endCb?.());
            break;
          }
          case 'error': {
            setImmediate(() => errorCb?.(new Error(behavior.message ?? 'ffmpeg: mock error')));
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
      },
    };

    return cmd;
  }

  require.cache[FFMPEG_PATH] = { id: FFMPEG_PATH, filename: FFMPEG_PATH, loaded: true, exports: factory };

  return {
    calls,
    restore() {
      if (previous) require.cache[FFMPEG_PATH] = previous;
      else delete require.cache[FFMPEG_PATH];
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
        assert.equal(err.message, 'attempt 3: thumbnail filter failed');
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
      onKill: ({ errorCb }) => {
        setTimeout(() => {
          assert.doesNotThrow(() => errorCb(new Error('late ffmpeg process error')));
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
