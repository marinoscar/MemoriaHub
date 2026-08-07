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
 * MOCK STRATEGY — the ffmpeg spawn seam:
 *
 * Identical technique to test/video.test.mjs (see that file's header for the
 * full rationale). In short: `transcodeToDecodableJpeg` shells out through the
 * package's own thin ffmpeg wrapper (src/ffmpeg/index.ts), which replaced the
 * deprecated fluent-ffmpeg dependency in issue #219. The old CJS
 * `require.cache` mock no longer applies — there is no such module, and the
 * technique cannot be pointed at `node:child_process` (a builtin) anyway. The
 * wrapper instead exposes an explicit `__setSpawnForTests()` seam, and this
 * file installs a fake `spawn` returning a scripted ChildProcess-alike. Every
 * assertion below is preserved verbatim in intent.
 *
 * transcodeToDecodableJpeg's ffmpeg call shape is the simplest of the four
 * this codebase uses: `['-i', <in>, '-y', '-vframes', '1', <out>]` — no `-ss`,
 * no `-filter:v`. That argv is pinned explicitly in test/ffmpeg.test.mjs.
 *
 * These tests import '@memoriahub/enrichment-compute/image' via the
 * package's `exports` map, so they exercise the BUILT dist/esm output — run
 * `npm run build` after editing src/image/index.ts before running `npm test`.
 * The seam is imported from the '/ffmpeg' subpath, which resolves to the SAME
 * module instance dist/esm/image/index.js imports as '../ffmpeg/index.js'
 * (Node's ESM cache is keyed by resolved URL).
 *
 * The final test in this file ("... decode a real HEIC fixture end-to-end")
 * is different in kind from the six above it: it decodes a real, committed
 * HEIC fixture (`test/fixtures/golden-fixture.heic`, added for issue #128)
 * through the real `computeDHash` pipeline. Historically (issue #106) that
 * pipeline could only decode HEIC via the ffmpeg fallback this file mocks
 * above, because sharp's bundled libvips omitted the HEVC decoder. As of
 * #128, both the API and worker Docker images ship a system HEIF-enabled
 * global libvips, so sharp decodes HEIC/HEIF NATIVELY and `computeDHash`
 * never reaches `transcodeToDecodableJpeg` at all in production — the
 * ffmpeg-mocked tests above remain the fallback's regression coverage
 * (AC#3: it still throws cleanly on corrupt input), while the authoritative
 * "did the parity gate's environment actually decode HEIC natively, and did
 * it skip the fallback" assertion lives in `test/golden.test.mjs` (which also
 * pins the one true `GOLDEN_HEIC_DHASH`, computed from an in-image decode —
 * see that file and fixtures/README.md).
 *
 * The test below therefore only asserts that `computeDHash` returns a valid
 * dHash for the real fixture in EITHER world (native sharp decode or ffmpeg
 * fallback) and does not require a real `ffmpeg` binary on PATH (a native
 * decode needs none). It still skips gracefully if the fixture is ever
 * missing, but no longer requires a real ffmpeg binary to run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { __setSpawnForTests } = await import('@memoriahub/enrichment-compute/ffmpeg');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEIC_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-fixture.heic');

// golden-fixture.heic is now committed (issue #128). This file's own pin stays
// null deliberately — the single source of truth for GOLDEN_HEIC_DHASH is
// test/golden.test.mjs, which computes it from the real computeDHash pipeline
// AND asserts the ffmpeg fallback was not invoked (i.e. that the value came
// from a genuine native decode). Pin the value there once verified in-image;
// this constant is kept here only so the assertion below stays "assert
// equality once pinned, else just print" like the JPEG golden test does.
const GOLDEN_HEIC_DHASH = null;

/**
 * Install a fake `spawn` for the duration of one test.
 *
 * `behavior` describes the single attempt transcodeToDecodableJpeg makes (it
 * does not retry a ladder of attempts the way extractPosterFrame does):
 *   { kind: 'success', bytes? }  — writes `bytes` (default non-empty) to the
 *                                  output path, then exits 0.
 *   { kind: 'empty' }            — exits 0 after writing a zero-byte file —
 *                                   exercises the assertNonEmptyFile guard.
 *   { kind: 'error', message? }  — exits 1 with `message` on stderr.
 *   { kind: 'hang' }             — never exits on its own; only the timeout's
 *                                  SIGKILL moves it along.
 *
 * Returns { restore, getCall } — `getCall()` returns the input path, output
 * path and kill signals for the (single) invocation, read back out of the real
 * argv the wrapper built.
 */
function installFakeFfmpeg(behavior) {
  const call = { inputPath: null, outputPath: null, killSignals: [], args: null };

  __setSpawnForTests((_command, args) => {
    call.args = [...args];
    call.inputPath = call.args[call.args.indexOf('-i') + 1];
    call.outputPath = call.args[call.args.length - 1];

    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.stdin = new EventEmitter();
    child.kill = (signal) => {
      call.killSignals.push(signal);
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
        const bytes = behavior.bytes ?? Buffer.from('fake-jpeg-bytes');
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
        // Never settles on its own — only a real timeout can move this along.
        break;
      }
      default:
        throw new Error(`unknown fake ffmpeg behavior kind: ${behavior.kind}`);
    }

    return child;
  });

  return {
    getCall: () => call,
    restore() {
      __setSpawnForTests(null);
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
        // The wrapper reports a non-zero ffmpeg exit as
        // `ffmpeg exited with code 1: <stderr>` — the same shape fluent-ffmpeg
        // produced for a real failing binary. What matters is that the
        // underlying complaint reaches the caller rather than being swallowed.
        assert.match(err.message, /ffmpeg: unsupported codec/);
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
// Real end-to-end decode — requires the committed HEIC fixture, but NOT a
// real ffmpeg binary: as of issue #128, a HEIF-enabled sharp decodes this
// fixture natively, so the ffmpeg fallback this file mocks above is never
// exercised in that world. On a machine where sharp lacks HEIF support but
// DOES have a real `ffmpeg` binary on PATH, the fallback would be exercised
// instead and still produce a hash. computeDHash never throws in either
// case — it swallows decode failures and returns null (see
// src/dhash/index.ts) — so this test also tolerates the third combination
// (neither a HEIF-capable sharp/libheif build NOR a real ffmpeg binary
// available, e.g. a bare-bones sandbox): computeDHash legitimately returns
// null there, and this test skips rather than treating that as a failure.
// The authoritative "did decode actually work, and was it native" enforcement
// lives in test/golden.test.mjs's HEIC test (with REQUIRE_HEIC_DECODE=1 in
// the CI parity gate) — this test is a looser, no-preconditions sanity check.
// Must skip gracefully (never hard-fail) if the fixture is somehow absent.
// ---------------------------------------------------------------------------

test('transcodeToDecodableJpeg + computeDHash decode a real HEIC fixture end-to-end', async (t) => {
  const hasFixture = await fileExists(HEIC_FIXTURE_PATH);
  if (!hasFixture) {
    t.skip(
      `no HEIC fixture found at ${HEIC_FIXTURE_PATH} — skipping end-to-end HEIC decode test. ` +
        'See test/fixtures/README.md for how golden-fixture.heic was generated.',
    );
    return;
  }

  const { computeDHash } = await import('@memoriahub/enrichment-compute/dhash');
  const buffer = await fs.readFile(HEIC_FIXTURE_PATH);

  const hash = await computeDHash(buffer);

  if (hash === null) {
    t.skip(
      'computeDHash returned null for the HEIC fixture — this environment has neither a HEIF-capable ' +
        'sharp/libheif build nor a working ffmpeg fallback (e.g. no real `ffmpeg` binary on PATH); skipping. ' +
        'See test/golden.test.mjs for the authoritative native-decode assertion enforced by the CI parity gate.',
    );
    return;
  }

  assert.equal(typeof hash, 'string');
  assert.ok(hash.length > 0, 'dHash should be a non-empty decimal string');
  assert.match(hash, /^\d+$/, 'dHash should be a decimal-string-encoded unsigned 64-bit value');

  if (GOLDEN_HEIC_DHASH !== null) {
    assert.equal(hash, GOLDEN_HEIC_DHASH);
  } else {
    // No golden value pinned yet — print it so a maintainer running this
    // locally (see fixtures/README.md) can copy it into GOLDEN_HEIC_DHASH.
    // The authoritative pin lives in test/golden.test.mjs's
    // GOLDEN_HEIC_DHASH, which also asserts the decode was native (no
    // ffmpeg fallback) — see that file's HEIC test for why.
    console.log(`[heic.test.mjs] computed dHash for golden-fixture.heic: ${hash} (pin this into GOLDEN_HEIC_DHASH once verified)`);
  }
});
