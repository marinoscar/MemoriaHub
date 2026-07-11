// =============================================================================
// SocialMediaOcrService
// =============================================================================
//
// Tier-2 OCR pass for social-media video detection.
//
// Extracts a handful of targeted frames from a video and runs them through the
// shared OCR engine in @memoriahub/enrichment-compute/ocr, which owns the pure
// tesseract mechanics: worker creation with a pinned language/model dir, the
// serialized recognize queue, frame preprocessing (downscale → grayscale →
// normalize via sharp), and per-word confidence filtering. The collected
// per-frame strings are handed to SocialMediaDetectorService.detectFromOcr.
//
// What stays HERE (host concerns, per the compute/persist split):
//   - NEVER throws. Any worker/model unavailability puts the service into a
//     sticky "degraded" mode where every call returns { available: false }.
//   - The OCR phase is bounded by a soft timeout. On timeout we return whatever
//     text was collected so far with available:true — a timeout is a budget
//     limit, not a model failure.
//   - Frame timestamp selection + extraction (ffmpeg via
//     VideoFrameExtractionService).
//   - Model/lang data is pinned under ${MODELS_DIR}/tesseract so downloaded
//     traineddata survives container recreation (mirrors the CLIP MODELS_DIR
//     precedent in dedup/visual-embedding.service.ts). The env read stays here;
//     the package takes langDir as a parameter.
// =============================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { join } from 'path';
import { createOcrEngine, OcrEngine } from '@memoriahub/enrichment-compute/ocr';
import { VideoFrameExtractionService } from '../face/video-frame-extraction.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

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

  private engine: OcrEngine | null = null;
  private engineInitPromise: Promise<OcrEngine | null> | null = null;
  private currentLanguages: string[] = [];

  /** Sticky flag: once true, all calls short-circuit to unavailable. */
  private degraded = false;
  private degradedWarned = false;

  constructor(
    private readonly frameExtractor: VideoFrameExtractionService,
    // Injected so the service participates in the settings-aware DI graph and so
    // future per-call setting reads have a handle; recognizeVideo receives its
    // knobs via opts (resolved by the caller from SystemSettingsService).
    private readonly systemSettings: SystemSettingsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.engine) {
      await this.engine.terminate();
      this.engine = null;
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

    // Ensure the engine is up before extracting frames so init failures degrade
    // cleanly without wasting ffmpeg work.
    const engine = await this.ensureEngine(languages);
    if (!engine) {
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

    const texts: string[] = [];
    let cancelled = false;

    const runOcr = async (): Promise<void> => {
      for (const frame of frames) {
        if (cancelled) return;

        const words = await engine.recognizeFrame(frame.buffer);
        const text = words.join(' ');
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
   * a lazy engine init (or returns cached degraded state) WITHOUT any frame
   * extraction, so it returns quickly (well under 10 s).
   */
  async getStatus(): Promise<OcrStatus> {
    const languages =
      this.currentLanguages.length > 0 ? this.currentLanguages : ['eng'];

    if (!this.degraded) {
      const engine = await this.ensureEngine(languages);
      if (!engine) {
        // ensureEngine set degraded internally on failure
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
  // Engine lifecycle
  // ---------------------------------------------------------------------------

  private tessDir(): string {
    return join(process.env['MODELS_DIR'] ?? './data/models', 'tesseract');
  }

  /**
   * Return a ready OCR engine for the requested languages, creating (or
   * recreating on language change) it lazily. Returns null and marks the
   * service degraded on any init/language-load failure.
   */
  private async ensureEngine(languages: string[]): Promise<OcrEngine | null> {
    if (this.degraded) return null;

    const langKey = [...languages].sort().join('+');
    const currentKey = [...this.currentLanguages].sort().join('+');

    if (this.engine && currentKey === langKey) {
      return this.engine;
    }

    // Coalesce concurrent init attempts for the same language set.
    if (this.engineInitPromise && currentKey === langKey) {
      return this.engineInitPromise;
    }

    this.engineInitPromise = this.initEngine(languages).catch((err) => {
      this.markDegraded(err);
      return null;
    });

    return this.engineInitPromise;
  }

  private async initEngine(languages: string[]): Promise<OcrEngine> {
    const langs = languages.length > 0 ? languages : ['eng'];
    const dir = this.tessDir();

    // Recreate on language change.
    if (this.engine) {
      await this.engine.terminate();
      this.engine = null;
    }

    const engine = await createOcrEngine({ langDir: dir, languages: langs });

    this.engine = engine;
    this.currentLanguages = [...langs];
    this.engineInitPromise = null;
    this.logger.log(
      `SocialMediaOcr: tesseract worker initialized (langs=${langs.join('+')}, dir=${dir})`,
    );
    return engine;
  }

  private markDegraded(err: unknown): void {
    this.degraded = true;
    this.engineInitPromise = null;
    if (!this.degradedWarned) {
      this.degradedWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `SocialMediaOcr: OCR unavailable — running in degraded mode (metadata/filename detection only). ${msg}`,
      );
    }
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
