/**
 * Tesseract OCR core (moved from
 * apps/api/src/social-media/social-media-ocr.service.ts).
 *
 * This module holds ONLY the pure tesseract mechanics of the Tier-2
 * social-media OCR pass: worker creation with a pinned language/model
 * directory, the serialized recognize queue (a single worker must never run
 * two jobs concurrently), frame preprocessing (downscale → grayscale →
 * normalize via sharp), and per-word confidence filtering. Degraded-mode
 * stickiness, the soft timeout budget, frame extraction, and settings reads
 * all stay in the host (the API's SocialMediaOcrService, or the CLI worker's
 * social-media handler). The package never reads env vars — the language/model
 * directory is an explicit parameter.
 *
 * tesseract.js is an exact-pinned optionalDependency loaded LAZILY at
 * createOcrEngine() time, so importing this subpath never crashes on a lean
 * install; a descriptive Error is thrown only when an engine is actually
 * requested.
 */

import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { nodeRequire } from '../node-require.cjs';

/** Minimum per-word OCR confidence (0–100) for a token to be kept. */
export const DEFAULT_WORD_CONFIDENCE_THRESHOLD = 60;

/** Long-edge width the frame is downscaled to before OCR. */
export const DEFAULT_OCR_FRAME_WIDTH = 720;

// ---------------------------------------------------------------------------
// Minimal structural types for the slice of tesseract.js we use — kept local
// so the public .d.ts never forces consumers to install tesseract.js types.
// ---------------------------------------------------------------------------

interface TesseractWord {
  text?: string;
  confidence?: number;
}
interface TesseractPage {
  blocks?: Array<{
    paragraphs?: Array<{
      lines?: Array<{ words?: TesseractWord[] }>;
    }>;
  }> | null;
}
interface TesseractWorker {
  recognize(
    image: Buffer,
    opts: Record<string, unknown>,
    output: Record<string, unknown>,
  ): Promise<{ data: TesseractPage }>;
  terminate(): Promise<unknown>;
}
type CreateWorkerFn = (
  langs: string[],
  oem: undefined,
  options: Record<string, unknown>,
) => Promise<TesseractWorker>;

export interface OcrEngineOptions {
  /**
   * Directory the tesseract traineddata is cached in / read from (the API pins
   * this under ${MODELS_DIR}/tesseract; the CLI under its own models dir).
   */
  langDir: string;
  /** tesseract language codes, e.g. ['eng']. */
  languages: string[];
  /** Minimum per-word confidence (0–100) to keep a token. Default 60. */
  wordConfidenceThreshold?: number;
  /** Width frames are downscaled to before OCR. Default 720. */
  frameWidth?: number;
}

export interface OcrEngine {
  /** The language set this engine was created with. */
  readonly languages: string[];
  /**
   * Preprocess a frame (downscale → grayscale → normalize; falls back to the
   * raw buffer if sharp cannot decode it), OCR it through the serialized
   * worker queue, and return the confidence-filtered words.
   */
  recognizeFrame(buffer: Buffer): Promise<string[]>;
  /** Tear the underlying tesseract worker down. Never throws. */
  terminate(): Promise<void>;
}

function loadCreateWorker(): CreateWorkerFn {
  try {
    const mod = nodeRequire('tesseract.js') as {
      createWorker?: CreateWorkerFn;
      default?: { createWorker?: CreateWorkerFn };
    };
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js does not export createWorker');
    }
    return createWorker;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OCR compute requires the optional dependency tesseract.js, which is not installed: ${msg}`,
    );
  }
}

/**
 * Create a ready OCR engine for the given language set.
 *
 * Mirrors the original service's worker init exactly:
 *  - traineddata is cached under `langDir` (cachePath) so the ~10 MB/lang
 *    download survives container recreation;
 *  - corePath is IGNORED by tesseract.js in Node (the wasm core is loaded via
 *    require('tesseract.js-core') — see worker-script/node/getCore.js), but we
 *    pin it under the models dir for parity with cachePath/langPath;
 *  - air-gapped support: if every requested language's traineddata is already
 *    present under `langDir`, it is read from disk (langPath); otherwise
 *    langPath is left unset so the first run downloads from the CDN default
 *    and caches into cachePath.
 *
 * Throws on init failure — degraded-mode policy is a host concern.
 */
export async function createOcrEngine(opts: OcrEngineOptions): Promise<OcrEngine> {
  const createWorker = loadCreateWorker();

  const langs = opts.languages.length > 0 ? [...opts.languages] : ['eng'];
  const dir = opts.langDir;
  const threshold = opts.wordConfidenceThreshold ?? DEFAULT_WORD_CONFIDENCE_THRESHOLD;
  const frameWidth = opts.frameWidth ?? DEFAULT_OCR_FRAME_WIDTH;

  await fsp.mkdir(dir, { recursive: true });

  const options: Record<string, unknown> = {
    // Downloaded traineddata is written here and read on subsequent runs.
    cachePath: dir,
    corePath: dir,
    logger: () => {},
    errorHandler: () => {},
  };

  const allLangsPresent = langs.every(
    (l) =>
      existsSync(join(dir, `${l}.traineddata`)) ||
      existsSync(join(dir, `${l}.traineddata.gz`)),
  );
  if (allLangsPresent) {
    options.langPath = dir;
  }

  const worker = await createWorker(langs, undefined, options);

  /** Serializes recognize() calls so the single worker runs one job at a time. */
  let recognizeChain: Promise<unknown> = Promise.resolve();

  return {
    languages: langs,

    async recognizeFrame(buffer: Buffer): Promise<string[]> {
      let prepared: Buffer;
      try {
        const sharp = (await import('sharp')).default;
        prepared = await sharp(buffer)
          .resize({ width: frameWidth, withoutEnlargement: true })
          .grayscale()
          .normalize()
          .toBuffer();
      } catch {
        prepared = buffer;
      }

      const run = recognizeChain.then(async () => {
        const { data } = await worker.recognize(prepared, {}, { blocks: true });
        return extractConfidentWords(data, threshold);
      });
      // Keep the chain alive regardless of this call's outcome.
      recognizeChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    async terminate(): Promise<void> {
      try {
        await worker.terminate();
      } catch {
        // ignore teardown errors
      }
    },
  };
}

/**
 * Walk a tesseract Page's block→paragraph→line→word tree and collect every
 * word whose recognition confidence meets the threshold.
 */
export function extractConfidentWords(
  page: TesseractPage,
  threshold: number = DEFAULT_WORD_CONFIDENCE_THRESHOLD,
): string[] {
  const words: string[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? '').trim();
          if (text && (word.confidence ?? 0) >= threshold) {
            words.push(text);
          }
        }
      }
    }
  }
  return words;
}
