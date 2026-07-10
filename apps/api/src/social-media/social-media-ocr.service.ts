// =============================================================================
// SocialMediaOcrService
// =============================================================================
//
// Tier-2 OCR pass for social-media video detection.
//
// Extracts a handful of targeted frames from a video, preprocesses each frame
// with sharp (downscale → grayscale → normalize), and runs tesseract.js OCR to
// recover on-screen text (platform watermarks, @usernames, "reels", etc.). The
// collected per-frame strings are handed to SocialMediaDetectorService.detectFromOcr.
//
// Design constraints:
//   - NEVER throws. Any worker/model unavailability puts the service into a
//     sticky "degraded" mode where every call returns { available: false }.
//   - A single lazily-created tesseract worker is reused across calls; recognize
//     calls are serialized through a promise chain so one worker is never asked
//     to run two jobs concurrently.
//   - The OCR phase is bounded by a soft timeout. On timeout we return whatever
//     text was collected so far with available:true — a timeout is a budget
//     limit, not a model failure.
//   - Model/lang data is pinned under ${MODELS_DIR}/tesseract so downloaded
//     traineddata survives container recreation (mirrors the CLIP MODELS_DIR
//     precedent in dedup/visual-embedding.service.ts).
// =============================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { createWorker, Worker, Page, WorkerOptions } from 'tesseract.js';
import { VideoFrameExtractionService } from '../face/video-frame-extraction.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** Minimum per-word OCR confidence (0–100) for a token to be kept. */
const WORD_CONFIDENCE_THRESHOLD = 60;

/** Long-edge width the frame is downscaled to before OCR. */
const OCR_FRAME_WIDTH = 720;

export interface RecognizeVideoOpts {
  durationMs?: number;
  fileExtension?: string;
  /** Hard cap on frames OCR'd (default 4). */
  maxFrames: number;
  /** tesseract language codes (default ['eng']). */
  languages: string[];
  /** Soft timeout for the whole OCR phase in ms. */
  timeoutMs: number;
}

export interface OcrStatus {
  ocrAvailable: boolean;
  degraded: boolean;
  modelPath: string;
  languages: string[];
}

@Injectable()
export class SocialMediaOcrService implements OnModuleDestroy {
  private readonly logger = new Logger(SocialMediaOcrService.name);

  private worker: Worker | null = null;
  private workerInitPromise: Promise<Worker | null> | null = null;
  private currentLanguages: string[] = [];

  /** Sticky flag: once true, all calls short-circuit to unavailable. */
  private degraded = false;
  private degradedWarned = false;

  /** Serializes recognize() calls so a single worker runs one job at a time. */
  private recognizeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly frameExtractor: VideoFrameExtractionService,
    // Injected so the service participates in the settings-aware DI graph and so
    // future per-call setting reads have a handle; recognizeVideo receives its
    // knobs via opts (resolved by the caller from SystemSettingsService).
    private readonly systemSettings: SystemSettingsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore teardown errors
      }
      this.worker = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run OCR over a small set of frames sampled from the video already on disk
   * at `videoPath` and return the per-frame recognized text. The caller owns
   * downloading/materializing `videoPath` and cleaning it up afterward.
   *
   * Never throws:
   *   - degraded / worker-init failure → { texts: [], available: false }
   *   - frame-extraction failure       → { texts: [], available: true }
   *   - soft-timeout                    → { texts: <collected>, available: true }
   */
  async recognizeVideo(
    videoPath: string,
    opts: RecognizeVideoOpts,
  ): Promise<{ texts: string[]; available: boolean }> {
    if (this.degraded) {
      return { texts: [], available: false };
    }

    const maxFrames = opts.maxFrames > 0 ? opts.maxFrames : 4;
    const languages = opts.languages?.length ? opts.languages : ['eng'];
    const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 60000;

    const timestamps = computeOcrTimestamps(opts.durationMs, maxFrames);

    // Ensure the worker is up before extracting frames so init failures degrade
    // cleanly without wasting ffmpeg work.
    const worker = await this.ensureWorker(languages);
    if (!worker) {
      return { texts: [], available: false };
    }

    let frames;
    try {
      frames = await this.frameExtractor.extractFramesAt(
        videoPath,
        timestamps,
        opts.fileExtension,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SocialMediaOcr: frame extraction failed — ${msg}`);
      return { texts: [], available: true };
    }

    if (frames.length === 0) {
      return { texts: [], available: true };
    }

    const sharp = (await import('sharp')).default;
    const texts: string[] = [];
    let cancelled = false;

    const runOcr = async (): Promise<void> => {
      for (const frame of frames) {
        if (cancelled) return;

        let prepared: Buffer;
        try {
          prepared = await sharp(frame.buffer)
            .resize({ width: OCR_FRAME_WIDTH, withoutEnlargement: true })
            .grayscale()
            .normalize()
            .toBuffer();
        } catch {
          prepared = frame.buffer;
        }

        if (cancelled) return;

        const text = await this.recognizeFrame(worker, prepared);
        if (text) texts.push(text);
      }
    };

    // Soft timeout: resolve with whatever has been collected on either the OCR
    // loop completing OR the budget elapsing. Setting `cancelled` stops the loop
    // from starting further frames after the in-flight one.
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cancelled = true;
        this.logger.warn(
          `SocialMediaOcr: OCR phase exceeded ${timeoutMs}ms budget; returning ${texts.length} partial frame text(s)`,
        );
        resolve();
      }, timeoutMs);

      runOcr()
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`SocialMediaOcr: OCR recognize error — ${msg}`);
          resolve();
        });
    });

    return { texts, available: true };
  }

  /**
   * Cheap availability probe for the admin status endpoint and Doctor. Attempts
   * a lazy worker init (or returns cached degraded state) WITHOUT any frame
   * extraction, so it returns quickly (well under 10 s).
   */
  async getStatus(): Promise<OcrStatus> {
    const languages =
      this.currentLanguages.length > 0 ? this.currentLanguages : ['eng'];

    if (!this.degraded) {
      const worker = await this.ensureWorker(languages);
      if (!worker) {
        // ensureWorker set degraded internally on failure
      }
    }

    return {
      ocrAvailable: !this.degraded,
      degraded: this.degraded,
      modelPath: this.tessDir(),
      languages: this.currentLanguages.length > 0 ? this.currentLanguages : languages,
    };
  }

  // ---------------------------------------------------------------------------
  // Worker lifecycle
  // ---------------------------------------------------------------------------

  private tessDir(): string {
    return join(process.env['MODELS_DIR'] ?? './data/models', 'tesseract');
  }

  /**
   * Return a ready worker for the requested languages, creating (or recreating
   * on language change) it lazily. Returns null and marks the service degraded
   * on any init/language-load failure.
   */
  private async ensureWorker(languages: string[]): Promise<Worker | null> {
    if (this.degraded) return null;

    const langKey = [...languages].sort().join('+');
    const currentKey = [...this.currentLanguages].sort().join('+');

    if (this.worker && currentKey === langKey) {
      return this.worker;
    }

    // Coalesce concurrent init attempts for the same language set.
    if (this.workerInitPromise && currentKey === langKey) {
      return this.workerInitPromise;
    }

    this.workerInitPromise = this.initWorker(languages).catch((err) => {
      this.markDegraded(err);
      return null;
    });

    return this.workerInitPromise;
  }

  private async initWorker(languages: string[]): Promise<Worker> {
    const langs = languages.length > 0 ? languages : ['eng'];
    const dir = this.tessDir();
    await fsp.mkdir(dir, { recursive: true });

    // Recreate on language change.
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }

    const options: Partial<WorkerOptions> = {
      // Downloaded traineddata is written here and read on subsequent runs, so
      // the ~10 MB/lang download survives container recreation.
      cachePath: dir,
      // corePath is IGNORED by tesseract.js in Node (the wasm core is loaded via
      // require('tesseract.js-core') — see worker-script/node/getCore.js), but we
      // pin it under the models dir for parity with cachePath/langPath.
      corePath: dir,
      logger: () => {},
      errorHandler: () => {},
    };

    // Air-gapped support: if the traineddata is already present under the models
    // dir, read it from disk (langPath). Otherwise leave langPath unset so the
    // first run downloads from the CDN default and caches into cachePath.
    const allLangsPresent = langs.every(
      (l) =>
        existsSync(join(dir, `${l}.traineddata`)) ||
        existsSync(join(dir, `${l}.traineddata.gz`)),
    );
    if (allLangsPresent) {
      options.langPath = dir;
    }

    const worker = await createWorker(langs, undefined, options);

    this.worker = worker;
    this.currentLanguages = [...langs];
    this.workerInitPromise = null;
    this.logger.log(
      `SocialMediaOcr: tesseract worker initialized (langs=${langs.join('+')}, dir=${dir}, langSource=${allLangsPresent ? 'local' : 'cdn'})`,
    );
    return worker;
  }

  private markDegraded(err: unknown): void {
    this.degraded = true;
    this.workerInitPromise = null;
    if (!this.degradedWarned) {
      this.degradedWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `SocialMediaOcr: OCR unavailable — running in degraded mode (metadata/filename detection only). ${msg}`,
      );
    }
  }

  /**
   * Serialize a single-frame recognize through the worker's promise chain and
   * return the confidence-filtered text.
   */
  private async recognizeFrame(worker: Worker, buffer: Buffer): Promise<string> {
    const run = this.recognizeChain.then(async () => {
      const { data } = await worker.recognize(buffer, {}, { blocks: true });
      return extractConfidentText(data);
    });
    // Keep the chain alive regardless of this call's outcome.
    this.recognizeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Compute the frame timestamps (ms) to OCR. Social watermarks/usernames tend to
 * sit near the very start and end of a re-shared clip, so we bias sampling to
 * both ends. Capped at `maxFrames`, deduped/clamped by extractFramesAt.
 */
function computeOcrTimestamps(
  durationMs: number | undefined,
  maxFrames: number,
): number[] {
  // Very short or unknown duration → cheap fallbacks.
  if (durationMs === undefined || durationMs <= 0) {
    return [0];
  }
  if (durationMs < 3000) {
    return [0, Math.max(0, durationMs - 300)];
  }

  const candidates = [
    300,
    1500,
    Math.max(0, durationMs - 2500),
    Math.max(0, durationMs - 800),
  ];

  return candidates.slice(0, Math.max(1, maxFrames));
}

/**
 * Walk a tesseract Page's block→paragraph→line→word tree and join every word
 * whose recognition confidence meets WORD_CONFIDENCE_THRESHOLD.
 */
function extractConfidentText(page: Page): string {
  const words: string[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? '').trim();
          if (text && (word.confidence ?? 0) >= WORD_CONFIDENCE_THRESHOLD) {
            words.push(text);
          }
        }
      }
    }
  }
  return words.join(' ');
}
