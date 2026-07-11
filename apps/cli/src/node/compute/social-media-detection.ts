/**
 * node/compute/social-media-detection.ts — Social-media video detection.
 *
 * Runs the two-tier classification locally via the shared
 * `@memoriahub/enrichment-compute` parity package so a node classifies a
 * video IDENTICALLY to the server for the same inputs — one rule catalog,
 * two hosts (distributed-nodes spec §7):
 *
 *   Tier 1: ffprobe container metadata + filename rules
 *           (probeVideo/extractContainerMetadata from /metadata,
 *           detectTier1 from /social).
 *   Tier 2: on-device OCR of a few targeted frames, run only when Tier 1 is
 *           inconclusive-but-suspicious and tesseract.js is installed
 *           (extractFramesAt from /video, createOcrEngine from /ocr,
 *           detectFromOcr from /social). Missing tesseract degrades to
 *           Tier-1-only, matching the server's degraded-mode policy — it is
 *           NOT a CapabilityUnavailableError, since Tier-1-only is a valid
 *           operating mode (see JOB_TYPE_REQUIREMENTS in ../capabilities.js,
 *           which lists only 'ffprobe' as hard-required for this job type).
 *
 * KNOWN GAP: `job.payload` is currently null for social_media_detection jobs
 * (see apps/api/src/media/enrichment/media-enrichment.service.ts's enqueue
 * call), so a node has no reliable original filename to feed Tier-1's
 * filename rules — only the container-metadata rules (read straight from the
 * downloaded bytes via ffprobe) are guaranteed to fire. `params.filename` is
 * still read defensively should a future payload addition supply it.
 *
 * The PRE-FLIGHT gates (duration/size caps, the landscape-no-OCR gate, the
 * feature flag) remain entirely server-authoritative — see
 * SocialMediaDetectionHandler.process/persistSocialMedia on the API side.
 * This module only ever computes the classification verdict, mirroring
 * computeSocialMedia's contract there.
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'social_media_detection'`:
 * `{ verdict, score, ocrText, platform, detectionMethod, matchedRule, confidence }`.
 */

import path from 'node:path';

import { probeVideo, extractContainerMetadata } from '@memoriahub/enrichment-compute/metadata';
import {
  detectTier1,
  detectFromOcr,
  computeOcrTimestamps,
  type VideoDetectionInput,
} from '@memoriahub/enrichment-compute/social';
import { extractFramesAt } from '@memoriahub/enrichment-compute/video';
import { createOcrEngine, type OcrEngine } from '@memoriahub/enrichment-compute/ocr';

import { modelsDir } from '../../paths.js';
import { loadNativeModule, NATIVE_MODULES, type ComputeFn } from '../capabilities.js';

const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_OCR_MAX_FRAMES = 4;
const DEFAULT_OCR_LANGUAGES = ['eng'];
const DEFAULT_OCR_TIMEOUT_MS = 60_000;

/**
 * Module-level lazy singleton for the tesseract OCR engine — worker init
 * costs real time, so it's cached across jobs for the worker's lifetime.
 * The promise (not the engine) is cached so concurrent jobs share a single
 * in-flight initialization. Resolves to null (never throws) when tesseract
 * is not installed or fails to initialize — the sticky degraded-mode policy
 * mirrors the server's SocialMediaOcrService.
 */
let enginePromise: Promise<OcrEngine | null> | null = null;
let engineLanguages: string[] = [];

function tessDir(): string {
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), 'tesseract');
}

function getOcrEngine(languages: string[]): Promise<OcrEngine | null> {
  const langKey = [...languages].sort().join('+');
  const currentKey = [...engineLanguages].sort().join('+');
  if (enginePromise && currentKey === langKey) return enginePromise;

  enginePromise = (async (): Promise<OcrEngine | null> => {
    try {
      await loadNativeModule(NATIVE_MODULES['tesseract']);
    } catch {
      return null; // tesseract.js not installed — degrade to Tier-1-only.
    }
    try {
      const engine = await createOcrEngine({ langDir: tessDir(), languages });
      engineLanguages = [...languages];
      return engine;
    } catch {
      return null; // init failure — degrade to Tier-1-only.
    }
  })().catch(() => null);

  return enginePromise;
}

/**
 * Run OCR over the given frames with a soft overall timeout budget — whatever
 * text has been collected when the budget elapses is returned, mirroring the
 * server's SocialMediaOcrService.recognizeVideo soft-timeout behavior. Never
 * throws.
 */
async function recognizeFramesWithBudget(
  engine: OcrEngine,
  frames: Array<{ buffer: Buffer }>,
  timeoutMs: number,
): Promise<string[]> {
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

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelled = true;
      resolve();
    }, timeoutMs);

    runOcr()
      .catch(() => {
        /* per-frame errors are non-fatal; whatever was collected stands */
      })
      .finally(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
  });

  return texts;
}

const computeSocialMediaDetection: ComputeFn = async (inputPath, params) => {
  const p = params as Record<string, unknown>;
  const minConfidence = typeof p['minConfidence'] === 'number' ? p['minConfidence'] : DEFAULT_MIN_CONFIDENCE;
  const ocrEnabled = p['ocrEnabled'] !== false;
  const ocrMaxFrames = typeof p['ocrMaxFrames'] === 'number' ? p['ocrMaxFrames'] : DEFAULT_OCR_MAX_FRAMES;
  const ocrLanguages = Array.isArray(p['ocrLanguages'])
    ? (p['ocrLanguages'] as string[])
    : DEFAULT_OCR_LANGUAGES;
  const ocrTimeoutMs = typeof p['ocrTimeoutMs'] === 'number' ? p['ocrTimeoutMs'] : DEFAULT_OCR_TIMEOUT_MS;
  // Best-effort — see the module docstring's KNOWN GAP re: job.payload.
  const filename = typeof p['filename'] === 'string' ? p['filename'] : null;

  // --- Tier 1: probe container metadata from the downloaded bytes ---
  const probeData = await probeVideo(inputPath);
  const container = extractContainerMetadata(probeData);

  const input: VideoDetectionInput = {
    kind: 'video',
    filename,
    formatTags: container.formatTags,
    streamTags: container.streamTags,
    formatName: container.formatName,
    durationMs: container.durationMs,
    width: container.width,
    height: container.height,
  };

  // Mirrors the server's orientation gate: landscape videos never get Tier-2 OCR.
  const isLandscape =
    input.width !== undefined && input.height !== undefined && input.width > input.height;

  const { result: tier1Result, recommendTier2: tier1RecommendsOcr } = detectTier1(
    input,
    minConfidence,
  );
  const recommendTier2 = tier1RecommendsOcr && !isLandscape;

  let result = tier1Result;
  let ocrText: string | null = null;

  // --- Tier 2: OCR fallback ---
  if (!result && recommendTier2 && ocrEnabled) {
    const engine = await getOcrEngine(ocrLanguages);
    if (engine) {
      const timestamps = computeOcrTimestamps(container.durationMs, ocrMaxFrames);
      const frames = await extractFramesAt(inputPath, timestamps);
      if (frames.length > 0) {
        const texts = await recognizeFramesWithBudget(engine, frames, ocrTimeoutMs);
        ocrText = texts.length > 0 ? texts.join(' \n ') : null;
        const ocrResult = detectFromOcr(texts, input, minConfidence);
        if (ocrResult) result = ocrResult;
      }
    }
  }

  if (result) {
    return {
      verdict: 'detected',
      score: result.confidence,
      ocrText,
      platform: result.platform,
      detectionMethod: result.method,
      matchedRule: result.matchedRule,
      confidence: result.confidence,
    };
  }

  return {
    verdict: 'clean',
    score: 0,
    ocrText,
    platform: null,
    detectionMethod: null,
    matchedRule: null,
    confidence: 0,
  };
};

export default computeSocialMediaDetection;
