/**
 * HEIC/HEIF decode regression test for @memoriahub/enrichment-compute
 * (GitHub issue #106).
 *
 * `packages/enrichment-compute/src/image/index.ts` implements a
 * `transcodeToDecodableJpeg` ffmpeg-based fallback wired into
 * `prepareImageForProcessing` / `getOrientedDimensions`, so that a HEIC/HEIF
 * photo (the default capture format on iPhone) can still be processed even
 * though sharp's underlying libvips build has no native HEIC decoder on most
 * deployment targets. `computeDHash` (from the `/dhash` subpath export)
 * routes through `prepareImageForProcessing`, so calling it on a HEIC file
 * exercises that fallback path end-to-end — decode failure -> ffmpeg
 * transcode to JPEG -> normal dHash pipeline.
 *
 * THIS TEST SKIPS (does not fail) unless both preconditions are met:
 *   1. `ffmpeg` is on PATH (checked via `ffmpeg -version`).
 *   2. `test/fixtures/golden-fixture.heic` is committed.
 *
 * Neither is true in most containers/CI images out of the box — sharp's
 * native binary alone cannot decode HEIC, and a real HEIC fixture can only
 * be produced by an ffmpeg build with libheif support (see
 * test/fixtures/README.md for how to add one). Until a maintainer commits
 * that fixture, this test is a documented no-op guard rather than a
 * currently-exercised regression check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEIC_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-fixture.heic');

const GOLDEN_HEIC_DHASH = null; // TODO(maintainer): pin once golden-fixture.heic is committed — run this test once ffmpeg + the fixture are present, copy the printed dHash here, then re-run to turn this into a bit-exact golden check

function isFfmpegOnPath() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    // Covers ffmpeg missing from PATH (ENOENT), a non-zero exit code, or any
    // other spawn failure — all treated identically as "ffmpeg unavailable".
    return false;
  }
}

function isHeicFixturePresent() {
  try {
    readFileSync(HEIC_FIXTURE_PATH);
    return true;
  } catch {
    return false;
  }
}

test('computeDHash decodes a HEIC photo via the ffmpeg transcode fallback (issue #106)', async (t) => {
  const missing = [];
  if (!isFfmpegOnPath()) missing.push('ffmpeg is not on PATH');
  if (!isHeicFixturePresent()) {
    missing.push(`golden-fixture.heic is absent from test/fixtures/ (expected at ${HEIC_FIXTURE_PATH})`);
  }

  if (missing.length > 0) {
    t.skip(
      `Skipping HEIC decode regression test: ${missing.join(', and ')}. ` +
        'See test/fixtures/README.md for how to add the golden-fixture.heic fixture and satisfy this precondition.',
    );
    return;
  }

  const { computeDHash } = await import('@memoriahub/enrichment-compute/dhash');
  const buffer = readFileSync(HEIC_FIXTURE_PATH);

  const hash = await computeDHash(buffer);

  assert.equal(typeof hash, 'string');
  assert.ok(hash.length > 0, 'dHash should be a non-empty string');
  assert.match(hash, /^\d+$/, 'dHash should be a decimal-string-encoded unsigned 64-bit value');

  if (GOLDEN_HEIC_DHASH !== null) {
    assert.equal(hash, GOLDEN_HEIC_DHASH);
  } else {
    console.log(`[heic.test.mjs] computed dHash for golden-fixture.heic: ${hash} (pin this into GOLDEN_HEIC_DHASH once verified)`);
  }
});
