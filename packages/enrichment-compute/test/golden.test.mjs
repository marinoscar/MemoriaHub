/**
 * Golden-vector parity regression test for @memoriahub/enrichment-compute.
 *
 * THIS IS THE REGRESSION GUARD for the distributed worker-nodes feature
 * (docs/specs/distributed-nodes.md §7): a worker node running the same
 * package version must produce numerically identical embeddings/hashes to
 * the server for the same input bytes. Silent drift here means corrupted
 * face clusters or duplicate groups downstream — a face/dedup KNN match
 * that works on the server but silently fails (or worse, silently matches
 * the wrong thing) on a node.
 *
 * Fixtures live in test/fixtures/ (see fixtures/README.md for how
 * golden-fixture.jpg was generated and how golden-clip-512.json was
 * derived). The committed JPEG bytes are decoded by this test forever —
 * never regenerate the fixture without also re-deriving the golden values.
 *
 * CLIP tolerance: the CLIP model call requires the ~89MB model file at
 * ~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx, which is not
 * checked into the repo and may be absent on CI/other machines — that test
 * SKIPS (not fails) when the file is missing.
 *
 * Observed max element-wise |diff| vs. the committed golden vector across
 * 5 consecutive runs on the dev machine (Linux, onnxruntime-node 1.27.0,
 * intraOpNumThreads: 2): 0 (bit-for-bit identical every run — CLIP inference
 * here is fully deterministic on a fixed machine/build). We do NOT assert
 * an exact-zero tolerance, because a different CPU architecture / SIMD
 * instruction set (e.g. a worker node without AVX2, or a future
 * onnxruntime-node point release) can reorder floating-point reductions in
 * the matmul and produce tiny non-zero diffs even for a bit-identical
 * model and inputs. 1e-4 is chosen as the tightest tolerance that
 * comfortably covers that class of cross-platform float noise while still
 * catching a real regression (wrong preprocessing, wrong mean/std, wrong
 * model, transposed tensor layout, etc. all produce diffs many orders of
 * magnitude larger than 1e-4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-fixture.jpg');
const GOLDEN_CLIP_PATH = path.join(__dirname, 'fixtures', 'golden-clip-512.json');
// Prefer MODELS_DIR (set inside the worker image, where the CLIP model is baked
// at /app/models) so the CI parity gate finds the model and runs the CLIP
// assertion instead of skipping; fall back to the CLI's default models dir.
const MODELS_DIR = process.env.MODELS_DIR
  ? process.env.MODELS_DIR
  : path.join(os.homedir(), '.memoriahub', 'models');
const MODEL_PATH = path.join(MODELS_DIR, 'clip-vit-b32-vision-quantized.onnx');

// dHash of golden-fixture.jpg, computed once and pinned. dHash is a
// bit-exact algorithm (resize + adjacent-pixel comparison), so this must
// match EXACTLY on every run/platform — no tolerance.
const GOLDEN_DHASH = '18446742974197923839';

const CLIP_MAX_DIFF_TOLERANCE = 1e-4;

test('computeDHash matches the committed golden value for golden-fixture.jpg', async () => {
  const { computeDHash } = await import('@memoriahub/enrichment-compute/dhash');
  const buffer = readFileSync(FIXTURE_PATH);

  const hash = await computeDHash(buffer);

  assert.equal(hash, GOLDEN_DHASH);
});

test('hammingDistance is 0 for a hash compared to itself', async () => {
  const { hammingDistance } = await import('@memoriahub/enrichment-compute/dhash');

  assert.equal(hammingDistance(GOLDEN_DHASH, GOLDEN_DHASH), 0);
});

test('hammingDistance sanity: known single-bit and 3-bit flips', async () => {
  const { hammingDistance } = await import('@memoriahub/enrichment-compute/dhash');

  const base = BigInt(GOLDEN_DHASH);

  // Flip the low bit only -> distance 1.
  const oneBitFlip = (base ^ 1n).toString();
  assert.equal(hammingDistance(GOLDEN_DHASH, oneBitFlip), 1);

  // Flip the low 3 bits (xor 0b111) -> distance 3.
  const threeBitFlip = (base ^ 7n).toString();
  assert.equal(hammingDistance(GOLDEN_DHASH, threeBitFlip), 3);
});

test('CLIP embedding of golden-fixture.jpg matches the committed golden vector', async (t) => {
  let modelBuffer;
  try {
    modelBuffer = readFileSync(MODEL_PATH);
  } catch {
    // REQUIRE_CLIP_MODEL=1 turns the "model absent" skip into a hard failure —
    // used by the CI parity gate that runs this test inside the worker image
    // (where the model is baked), so a missing/misplaced model fails the build
    // instead of silently passing as a skip.
    if (process.env.REQUIRE_CLIP_MODEL === '1') {
      assert.fail(
        `REQUIRE_CLIP_MODEL=1 but CLIP model not found at ${MODEL_PATH} — the baked model is missing or MODELS_DIR is wrong.`,
      );
    }
    t.skip(
      `CLIP model not found at ${MODEL_PATH} (expected on CI/other machines) — skipping CLIP golden-vector test. ` +
        'Download the model (~89MB, sha256 583fd111...) to run this test locally.',
    );
    return;
  }
  assert.ok(modelBuffer.length > 0, 'model file should be non-empty if present');

  const { createClipSession, embedImageWithSession, VISUAL_EMBEDDING_DIMENSIONS } = await import(
    '@memoriahub/enrichment-compute/clip'
  );

  const buffer = readFileSync(FIXTURE_PATH);
  const golden = JSON.parse(readFileSync(GOLDEN_CLIP_PATH, 'utf8'));

  const session = await createClipSession(MODEL_PATH);
  const embedding = await embedImageWithSession(session, buffer);

  assert.ok(embedding, 'embedImageWithSession should not return null for a decodable JPEG');
  assert.equal(embedding.length, VISUAL_EMBEDDING_DIMENSIONS);
  assert.equal(embedding.length, golden.length);

  // L2 norm should be ~1 (the embedding is L2-normalized by l2Normalize).
  let sumSq = 0;
  for (const v of embedding) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  assert.ok(
    Math.abs(norm - 1) < 1e-3,
    `expected L2 norm ~= 1, got ${norm}`,
  );

  // Element-wise max |diff| vs the committed golden vector.
  let maxDiff = 0;
  for (let i = 0; i < embedding.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(embedding[i] - golden[i]));
  }
  assert.ok(
    maxDiff < CLIP_MAX_DIFF_TOLERANCE,
    `expected max element-wise diff < ${CLIP_MAX_DIFF_TOLERANCE}, got ${maxDiff}`,
  );
});
