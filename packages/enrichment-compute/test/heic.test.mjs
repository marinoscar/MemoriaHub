/**
 * Unit tests for @memoriahub/enrichment-compute/image — transcodeToDecodableJpeg.
 *
 * This is the ffmpeg-transcode fallback added for issue #106: sharp's bundled
 * libvips omits the HEVC decoder (patent/licensing reasons), so HEIC/HEIF
 * input that sharp cannot decode is transcoded to a plain JPEG via ffmpeg
 * before being handed back into the normal sharp pipeline
 * (`prepareImageForProcessing` / `getOrientedDimensions` in
 * src/image/index.ts). Those two callers are NOT tested here — they require a
 * real sharp decode to exercise the fallback branch, which is unreliable in
 * this sandbox. This file tests `transcodeToDecodableJpeg` directly: it is
 * pure ffmpeg + fs, zero sharp involvement.
 *
 * MOCK STRATEGY — fluent-ffmpeg:
 *
 * Identical technique to test/video.test.mjs's extractPosterFrame tests (see
 * that file's header comment for the full rationale). In short:
 * `loadFfmpeg()` inside src/image/index.ts loads fluent-ffmpeg lazily via
 * `nodeRequire('fluent-ffmpeg')` (a real CJS require). This package's test
 * convention is Node's built-in test runner (no Jest, no module-mock
 * hoisting), so fluent-ffmpeg is mocked at the CJS `require.cache` level:
 * `createRequire(import.meta.url).resolve('fluent-ffmpeg')` resolves to the
 * SAME absolute path node-require.cts's `require('fluent-ffmpeg')` call
 * resolves to (single process-wide CJS module cache keyed by resolved
 * filename), so pre-seeding `require.cache[thatPath]` with a fake module
 * object means the real `require('fluent-ffmpeg')` call returns the fake
 * instead of ever touching the real package (which would try to invoke a
 * real `ffmpeg` binary). No source changes were made to support this.
 *
 * transcodeToDecodableJpeg's ffmpeg call shape is simpler than
 * extractPosterFrame's: just `.frames(1).output(path).on('end'|'error',
 * cb).run()` / `.kill()` — no `.seekInput()`/`.videoFilters()`.
 *
 * These tests import '@memoriahub/enrichment-compute/image' via the
 * package's `exports` map, so they exercise the BUILT dist/esm output — run
 * `npm run build` after editing src/image/index.ts before running `npm test`
 * (verified the current dist/esm/image/index.js already contains
 * transcodeToDecodableJpeg — no rebuild was needed for this change).
 *
 * The final test in this file ("... decode a real HEIC fixture end-to-end")
 * is different in kind from the six above it: it exercises the REAL,
 * non-mocked ffmpeg binary against a real HEIC fixture, routed through
 * computeDHash (which internally calls prepareImageForProcessing's ffmpeg
 * fallback). It requires both a real `ffmpeg` on PATH and a committed
 * `test/fixtures/golden-fixture.heic` — neither exists in this sandbox — so
 * it MUST skip gracefully (never hard-fail) when either is absent. See
 * fixtures/README.md for how to supply both and pin GOLDEN_HEIC_DHASH below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FFMPEG_PATH = require.resolve('fluent-ffmpeg');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEIC_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-fixture.heic');

// TODO(maintainer): once golden-fixture.heic exists, run the currently-skipped
// real-fixture decode test below, capture the resulting dHash, and pin it here.
const GOLDEN_HEIC_DHASH = null; // TODO: pin once fixture exists

/**
 * Install a fake fluent-ffmpeg module into the shared CJS require cache for
 * the duration of one test, restoring whatever was cached before.
 *
 * `behavior` describes the single attempt transcodeToDecodableJpeg makes (it
 * does not retry a ladder of attempts the way extractPosterFrame does):
 *   { kind: 'success', bytes? }  — writes `bytes` (default non-empty) to the
 *                                  output path, then fires 'end'.
 *   { kind: 'empty' }            — fires 'end' but writes a zero-byte file —
 *                                   exercises the assertNonEmptyFile guard.
 *   { kind: 'error', message? }  — fires 'error' with an Error.
 *   { kind: 'hang' }             — never settles on its own; only the
 *                                  timeout's SIGKILL moves it along.
 *
 * Returns { restore, getCall } — `getCall()` returns the recorded input path,
 * output path, and kill signals received for the (single) invocation.
 */
function installFakeFfmpeg(behavior) {
  const previous = require.cache[FFMPEG_PATH];
  const call = { inputPath: null, outputPath: null, killSignals: [] };

  function factory(inputPath) {
    call.inputPath = inputPath;

    let endCb = null;
    let errorCb = null;

    const cmd = {
      frames() {
        return cmd;
      },
      output(path_) {
        call.outputPath = path_;
        return cmd;
      },
      on(event, cb) {
        if (event === 'end') endCb = cb;
        if (event === 'error') errorCb = cb;
        return cmd;
      },
      kill(signal) {
        call.killSignals.push(signal);
      },
      run() {
        switch (behavior.kind) {
          case 'success': {
            const bytes = behavior.bytes ?? Buffer.from('fake-jpeg-bytes');
            fs.writeFile(call.outputPath, bytes).then(() => endCb?.());
            break;
          }
          case 'empty': {
            fs.writeFile(call.outputPath, Buffer.alloc(0)).then(() => endCb?.());
            break;
          }
          case 'error': {
            setImmediate(() => errorCb?.(new Error(behavior.message ?? 'ffmpeg: mock error')));
            break;
          }
          case 'hang': {
            // Never settles on its own — only a real timeout can move this along.
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
    getCall: () => call,
    restore() {
      if (previous) require.cache[FFMPEG_PATH] = previous;
      else delete require.cache[FFMPEG_PATH];
    },
  };
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('transcodeToDecodableJpeg returns the transcoded bytes on success', async () => {
  const { getCall, restore } = installFakeFfmpeg({ kind: 'success', bytes: Buffer.from('real-jpeg-bytes') });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');
    const buf = await transcodeToDecodableJpeg(Buffer.from('fake-heic-input'));

    assert.equal(buf.toString(), 'real-jpeg-bytes');
    assert.ok(getCall().inputPath, 'ffmpeg should have been invoked with an input path');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Temp file naming + cleanup on success
// ---------------------------------------------------------------------------

test('cleans up both temp files on success, using the default .heic input extension', async () => {
  const { getCall, restore } = installFakeFfmpeg({ kind: 'success' });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');
    await transcodeToDecodableJpeg(Buffer.from('fake-heic-input'));

    const { inputPath, outputPath } = getCall();
    assert.match(basename(inputPath), /^memoriaHub-heic-in-.+\.heic$/);
    assert.match(basename(outputPath), /^memoriaHub-heic-out-.+\.jpg$/);

    assert.equal(await fileExists(inputPath), false, 'input temp file must be cleaned up');
    assert.equal(await fileExists(outputPath), false, 'output temp file must be cleaned up');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Custom fileExtension option
// ---------------------------------------------------------------------------

test('respects a custom fileExtension option (no leading dot, mixed case, not lowercased)', async () => {
  const { getCall, restore } = installFakeFfmpeg({ kind: 'success' });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');
    await transcodeToDecodableJpeg(Buffer.from('fake-heif-input'), { fileExtension: 'HEIF' });

    const { inputPath } = getCall();
    assert.match(basename(inputPath), /^memoriaHub-heic-in-.+\.HEIF$/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// ffmpeg error
// ---------------------------------------------------------------------------

test('rejects and cleans up both temp files when ffmpeg fires an error event', async () => {
  const { getCall, restore } = installFakeFfmpeg({ kind: 'error', message: 'ffmpeg: unsupported codec' });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');

    await assert.rejects(
      () => transcodeToDecodableJpeg(Buffer.from('fake-heic-input')),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'ffmpeg: unsupported codec');
        return true;
      },
    );

    const { inputPath, outputPath } = getCall();
    assert.equal(await fileExists(inputPath), false, 'input temp file must be cleaned up on failure');
    assert.equal(await fileExists(outputPath), false, 'output temp file must be cleaned up on failure');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Empty output file
// ---------------------------------------------------------------------------

test('rejects when ffmpeg exits cleanly but writes a zero-byte output file', async () => {
  const { restore } = installFakeFfmpeg({ kind: 'empty' });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');

    await assert.rejects(
      () => transcodeToDecodableJpeg(Buffer.from('fake-heic-input')),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /empty output file/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Timeout / SIGKILL
// ---------------------------------------------------------------------------

test('kills a hung ffmpeg process with SIGKILL and rejects with a timeout message', async () => {
  const { getCall, restore } = installFakeFfmpeg({ kind: 'hang' });

  try {
    const { transcodeToDecodableJpeg } = await import('@memoriahub/enrichment-compute/image');

    await assert.rejects(
      () => transcodeToDecodableJpeg(Buffer.from('fake-heic-input'), { ffmpegTimeoutMs: 30 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /timed out after 30ms/);
        return true;
      },
    );

    const { inputPath, outputPath, killSignals } = getCall();
    assert.deepEqual(killSignals, ['SIGKILL']);
    assert.equal(await fileExists(inputPath), false, 'input temp file must be cleaned up after a timeout');
    assert.equal(await fileExists(outputPath), false, 'output temp file must be cleaned up after a timeout');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Real end-to-end decode — REQUIRES a real ffmpeg binary AND a real HEIC
// fixture, neither of which exists in this sandbox. Must skip gracefully in
// both cases, never hard-fail.
// ---------------------------------------------------------------------------

test('transcodeToDecodableJpeg + computeDHash decode a real HEIC fixture end-to-end', async (t) => {
  const ffmpegProbe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  const hasRealFfmpeg = !ffmpegProbe.error && ffmpegProbe.status === 0;

  if (!hasRealFfmpeg) {
    t.skip(
      'real ffmpeg binary not found on PATH (expected in this sandbox/CI) — skipping end-to-end HEIC ' +
        'decode test. Install ffmpeg to run this test locally.',
    );
    return;
  }

  const hasFixture = await fileExists(HEIC_FIXTURE_PATH);
  if (!hasFixture) {
    t.skip(
      `no HEIC fixture found at ${HEIC_FIXTURE_PATH} — skipping end-to-end HEIC decode test. ` +
        'Drop in a real HEIC file at that path (see test/fixtures/README.md for how to generate one) ' +
        'and pin its golden dHash as GOLDEN_HEIC_DHASH in this file to enable this test.',
    );
    return;
  }

  const { computeDHash } = await import('@memoriahub/enrichment-compute/dhash');
  const buffer = await fs.readFile(HEIC_FIXTURE_PATH);

  const hash = await computeDHash(buffer);

  assert.equal(typeof hash, 'string');
  assert.ok(hash.length > 0, 'dHash should be a non-empty decimal string');
  assert.match(hash, /^\d+$/, 'dHash should be a decimal-string-encoded unsigned 64-bit value');

  if (GOLDEN_HEIC_DHASH !== null) {
    assert.equal(hash, GOLDEN_HEIC_DHASH);
  } else {
    // No golden value pinned yet — print it so a maintainer running this
    // locally (see fixtures/README.md) can copy it into GOLDEN_HEIC_DHASH.
    console.log(`[heic.test.mjs] computed dHash for golden-fixture.heic: ${hash} (pin this into GOLDEN_HEIC_DHASH once verified)`);
  }
});
