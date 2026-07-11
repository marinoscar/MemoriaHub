/**
 * node/self-test.ts — Real operational self-tests for worker-node capabilities.
 *
 * `detectCapabilities()` in ./capabilities.js only proves a native module is
 * INSTALLED (require.resolve — no side effects). That is necessary but not
 * sufficient: a library can resolve and still fail at runtime (wrong native
 * binary for the platform/arch, corrupt install, missing shared libs) or be
 * installed-but-unusable because its model files haven't been downloaded yet
 * (CLIP/Human/tesseract are all model-driven).
 *
 * This module takes a capability snapshot from `detectCapabilities()` and, for
 * every capability reported PRESENT, attempts a minimal real operation:
 *
 *   - sharp:        decode+encode a tiny in-memory raw buffer.
 *   - onnxruntime:  load the CLIP session and embed a synthetic JPEG (only
 *                   when the model file has already been downloaded).
 *   - human:        load the face detector and run detection on a synthetic
 *                   JPEG (only when the Human model files are present).
 *   - tesseract:    init + terminate an OCR worker (only when language data
 *                   is present).
 *   - ffmpeg/ffprobe: left as the existing binary `-version` presence probe
 *                   (see detectCapabilities) — generating a synthetic media
 *                   asset to decode adds real complexity (codec/filter
 *                   availability varies across ffmpeg builds) for a check
 *                   that already executes and inspects the real binary,
 *                   unlike a require.resolve() presence check. Not upgraded
 *                   in this pass.
 *
 * A missing model file is NOT a hard failure — a node that has never claimed
 * a job needing that model yet (models are fetched lazily on `node start`)
 * legitimately doesn't have it. Those cases report `available: false` with a
 * descriptive, non-alarming `detail` distinguishing "not yet operational"
 * from "broken install" so the doctor report reads correctly either way.
 *
 * Every self-test has its own timeout and is wrapped in try/catch — a broken
 * native binary or hung model load must never crash `node doctor`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  createClipSession,
  embedImageWithSession,
} from '@memoriahub/enrichment-compute/clip';
import { createFaceDetector } from '@memoriahub/enrichment-compute/face';
import { createOcrEngine } from '@memoriahub/enrichment-compute/ocr';
import { testComprefaceStatus } from '@memoriahub/enrichment-compute/face-compreface';

import { modelsDir } from '../paths.js';
import { DEFAULT_COMPREFACE_URL, type CapabilityStatus } from './capabilities.js';

/** Must match apps/cli/src/node/compute/duplicate-detection.ts's CLIP_MODEL_FILENAME. */
const CLIP_MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';

/** Per-self-test timeout — generous enough for a cold model load, still bounded. */
const SHARP_TIMEOUT_MS = 5_000;
const CLIP_TIMEOUT_MS = 20_000;
const HUMAN_TIMEOUT_MS = 25_000;
const TESSERACT_TIMEOUT_MS = 20_000;
const COMPREFACE_TIMEOUT_MS = 5_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Race a self-test against a timeout, never letting either throw past this. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A tiny 4x4 raw RGB pixel buffer — enough for sharp to decode/encode. */
function tinyRawRgb(): { data: Buffer; width: number; height: number; channels: 3 } {
  const width = 4;
  const height = 4;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  // A few non-uniform values so this isn't a degenerate all-zero buffer.
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  return { data, width, height, channels };
}

/**
 * sharp self-test: decode a tiny synthetic raw pixel buffer and re-encode it
 * as JPEG. Proves the native libvips binding actually runs (not just that the
 * package resolves) — a wrong-platform prebuild fails here, not at require time.
 */
export async function testSharp(): Promise<CapabilityStatus> {
  try {
    return await withTimeout(
      async () => {
        const sharp = (await import('sharp')).default;
        const { data, width, height, channels } = tinyRawRgb();
        const out = await sharp(data, { raw: { width, height, channels } })
          .jpeg()
          .toBuffer();
        if (!out || out.length === 0) {
          return { available: false, detail: 'sharp encode produced empty output' };
        }
        return { available: true, detail: `sharp encode/decode roundtrip ok (${out.length} bytes)` };
      },
      SHARP_TIMEOUT_MS,
      'sharp self-test',
    );
  } catch (err) {
    return { available: false, detail: `sharp self-test failed: ${errMsg(err)}` };
  }
}

/** Build a tiny synthetic JPEG (via sharp) to feed to CLIP/Human self-tests. */
async function tinySyntheticJpeg(size = 64): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const { data, width, height, channels } = tinyRawRgb();
  return sharp(data, { raw: { width, height, channels } })
    .resize(size, size)
    .jpeg()
    .toBuffer();
}

/** Absolute path the CLI worker downloads the CLIP vision model to. */
function clipModelPath(): string {
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), CLIP_MODEL_FILENAME);
}

/**
 * CLIP (onnxruntime) self-test: only runs when the model file is already
 * downloaded — a node's models are fetched lazily on `node start`, so a fresh
 * `node doctor` before the first start legitimately has nothing to load yet.
 * When present, creates a real inference session and embeds a synthetic
 * image, asserting the expected 512-d output.
 */
export async function testClip(): Promise<CapabilityStatus> {
  const modelPath = clipModelPath();
  if (!fs.existsSync(modelPath)) {
    return {
      available: false,
      detail:
        `CLIP model not downloaded yet (expected at ${modelPath}) — models are fetched ` +
        'automatically on `node start`; duplicate_detection falls back to dHash-only ' +
        'degraded mode until then.',
    };
  }
  try {
    return await withTimeout(
      async () => {
        const jpeg = await tinySyntheticJpeg();
        const session = await createClipSession(modelPath);
        const embedding = await embedImageWithSession(session, jpeg);
        if (!embedding || embedding.length !== 512) {
          return {
            available: false,
            detail: `CLIP embed produced unexpected output (length=${embedding?.length ?? 'null'}, expected 512)`,
          };
        }
        return { available: true, detail: `CLIP embed ok — 512-d vector from ${modelPath}` };
      },
      CLIP_TIMEOUT_MS,
      'CLIP self-test',
    );
  } catch (err) {
    return { available: false, detail: `CLIP self-test failed: ${errMsg(err)}` };
  }
}

/** Must match apps/cli/src/node/compute/face-detection.ts's resolveModelBasePath(). */
function humanModelBasePath(): string {
  const override = process.env['FACE_HUMAN_MODEL_PATH'];
  if (override) return override;
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), 'human');
}

/**
 * Human (face) self-test: only runs when the Human model directory is
 * already present. When present, loads the real detector and runs detection
 * on a synthetic (faceless) JPEG — an empty `faces` array is a PASS, since
 * this proves the pipeline runs end-to-end, not that it finds a face.
 */
export async function testHuman(): Promise<CapabilityStatus> {
  const modelBasePath = humanModelBasePath();
  if (!fs.existsSync(modelBasePath)) {
    return {
      available: false,
      detail:
        `Human model files not present at ${modelBasePath} — models are fetched ` +
        'automatically on `node start`; face_detection/video_face_detection are not yet ' +
        'operational on this node.',
    };
  }
  try {
    return await withTimeout(
      async () => {
        const jpeg = await tinySyntheticJpeg();
        const detector = await createFaceDetector({ modelBasePath });
        const out = await detector.detect(jpeg);
        return {
          available: true,
          detail: `Human detector ok — ran end-to-end (${out.faces.length} face(s) on synthetic image)`,
        };
      },
      HUMAN_TIMEOUT_MS,
      'Human face self-test',
    );
  } catch (err) {
    return { available: false, detail: `Human self-test failed: ${errMsg(err)}` };
  }
}

/** Must match apps/cli/src/node/compute/social-media-detection.ts's tessDir(). */
function tesseractLangDir(): string {
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), 'tesseract');
}

/** True when every requested language's trained data file is on disk. */
function tesseractLangDataPresent(dir: string, languages: string[]): boolean {
  return languages.every(
    (l) =>
      fs.existsSync(path.join(dir, `${l}.traineddata`)) ||
      fs.existsSync(path.join(dir, `${l}.traineddata.gz`)),
  );
}

/**
 * tesseract self-test: only runs when English language data is already
 * present (downloaded lazily by the OCR engine on first use otherwise).
 * When present, creates a real worker and tears it down cleanly.
 */
export async function testTesseract(): Promise<CapabilityStatus> {
  const langDir = tesseractLangDir();
  const languages = ['eng'];
  if (!tesseractLangDataPresent(langDir, languages)) {
    return {
      available: false,
      detail:
        `tesseract language data not present at ${langDir} — OCR (social_media_detection ` +
        'Tier-2) runs in Tier-1-only degraded mode until language data is downloaded on first use.',
    };
  }
  try {
    return await withTimeout(
      async () => {
        const engine = await createOcrEngine({ langDir, languages });
        await engine.terminate();
        return { available: true, detail: `tesseract worker init/terminate ok (${languages.join('+')})` };
      },
      TESSERACT_TIMEOUT_MS,
      'tesseract self-test',
    );
  } catch (err) {
    return { available: false, detail: `tesseract self-test failed: ${errMsg(err)}` };
  }
}

/**
 * CompreFace self-test: probes a live compreface-core sidecar's `/status`
 * endpoint via the shared package's client (full reuse — no HTTP logic is
 * reimplemented here). Only invoked when `detectCapabilities()` already
 * reported the sidecar reachable; wraps the call with this module's own
 * timeout/error-handling conventions.
 */
export async function testCompreface(baseUrl: string): Promise<CapabilityStatus> {
  try {
    return await withTimeout(
      async () => {
        const result = await testComprefaceStatus(baseUrl);
        if (!result.ok) {
          return {
            available: false,
            detail: `compreface self-test failed: ${result.error ?? 'unknown error'}`,
          };
        }
        return { available: true, detail: `CompreFace core ok at ${baseUrl}` };
      },
      COMPREFACE_TIMEOUT_MS,
      'compreface self-test',
    );
  } catch (err) {
    return { available: false, detail: `compreface self-test failed: ${errMsg(err)}` };
  }
}

/**
 * Run every applicable operational self-test against a `detectCapabilities()`
 * snapshot. Only capabilities reported PRESENT are exercised; anything
 * already `available: false` (or not one of the tested keys — ffmpeg/ffprobe)
 * is passed through unchanged.
 *
 * Never throws — every self-test is individually wrapped, so one broken
 * capability never prevents the rest of the report from being produced.
 */
export async function runOperationalSelfTests(
  caps: Record<string, CapabilityStatus>,
  opts?: { comprefaceUrl?: string },
): Promise<Record<string, CapabilityStatus>> {
  const result: Record<string, CapabilityStatus> = { ...caps };

  if (caps['sharp']?.available) {
    result['sharp'] = await testSharp();
  }
  if (caps['onnxruntime']?.available) {
    result['onnxruntime'] = await testClip();
  }
  if (caps['human']?.available) {
    result['human'] = await testHuman();
  }
  if (caps['tesseract']?.available) {
    result['tesseract'] = await testTesseract();
  }
  if (caps['compreface']?.available) {
    result['compreface'] = await testCompreface(opts?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL);
  }
  // ffmpeg/ffprobe/tfjs/tfjsWasm: left as the presence-only probe — see the
  // module docstring for tfjs/tfjsWasm (exercised transitively by testHuman)
  // and ffmpeg/ffprobe (binary `-version` execution already proves the
  // binary runs, unlike a require.resolve() check).

  return result;
}
