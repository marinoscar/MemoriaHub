import { Injectable } from '@nestjs/common';

/**
 * Social-media video detection — pure rule engine.
 *
 * SocialMediaDetectorService is a zero-IO, synchronous, dependency-free service
 * that classifies whether a video was downloaded/re-shared from a social-media
 * platform (TikTok, Instagram, Facebook) based on container metadata, filename,
 * and (optionally) OCR text.  It performs NO database access and NO network/disk
 * IO, so it is fully unit-testable in isolation.
 *
 * The rule sets are DATA-DRIVEN (module-level `const` arrays) so adding a new
 * platform or heuristic is a data-only change.
 */

export type SocialPlatform = 'tiktok' | 'instagram' | 'facebook' | 'other';
export type DetectionMethod = 'metadata' | 'filename' | 'ocr';

export interface VideoDetectionInput {
  kind: 'video';
  filename?: string | null;
  /** ffprobe format tags — keys already lowercased, values string-coerced. */
  formatTags?: Record<string, string>;
  /** ffprobe per-stream tags — keys already lowercased, values string-coerced. */
  streamTags?: Array<Record<string, string>>;
  formatName?: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface DetectionResult {
  platform: SocialPlatform;
  method: DetectionMethod;
  /** Confidence in the range 0..1. */
  confidence: number;
  /** Identifier of the rule that produced the match. */
  matchedRule: string;
}

/**
 * A single deterministic rule against a VideoDetectionInput.  `source`
 * distinguishes container-metadata rules from filename rules, and maps directly
 * onto the DetectionResult `method`.
 */
interface DetectionRule {
  id: string;
  platform: SocialPlatform;
  source: 'metadata' | 'filename';
  confidence: number;
  match: (input: VideoDetectionInput) => boolean;
}

/**
 * A suspicion heuristic — a soft signal that a video *might* be a social re-share
 * but is not conclusive on its own.  Heuristics NEVER produce a DetectionResult;
 * they only nudge detectTier1 into recommending the (more expensive) Tier-2 OCR
 * pass.
 */
interface SuspicionHeuristic {
  id: string;
  match: (input: VideoDetectionInput) => boolean;
}

// ---------------------------------------------------------------------------
// Tag-scanning helpers
// ---------------------------------------------------------------------------

/** All tag bags (format + every stream) for a uniform scan. */
function allTagBags(input: VideoDetectionInput): Array<Record<string, string>> {
  const bags: Array<Record<string, string>> = [];
  if (input.formatTags) bags.push(input.formatTags);
  if (input.streamTags) bags.push(...input.streamTags);
  return bags;
}

/** True if any tag KEY or VALUE (case-insensitive) contains `needle`. */
function anyTagKeyOrValueContains(input: VideoDetectionInput, needle: string): boolean {
  const n = needle.toLowerCase();
  for (const bag of allTagBags(input)) {
    for (const [k, v] of Object.entries(bag)) {
      if (k.toLowerCase().includes(n) || String(v).toLowerCase().includes(n)) return true;
    }
  }
  return false;
}

/** True if any tag VALUE (case-insensitive) contains `needle`. */
function anyTagValueContains(input: VideoDetectionInput, needle: string): boolean {
  const n = needle.toLowerCase();
  for (const bag of allTagBags(input)) {
    for (const v of Object.values(bag)) {
      if (String(v).toLowerCase().includes(n)) return true;
    }
  }
  return false;
}

/** Filename, never null. */
function fileName(input: VideoDetectionInput): string {
  return input.filename ?? '';
}

/** True if the video carries device-capture tags (Apple/Android camera). */
function hasDeviceCaptureTags(input: VideoDetectionInput): boolean {
  for (const bag of allTagBags(input)) {
    for (const key of Object.keys(bag)) {
      const lk = key.toLowerCase();
      if (lk === 'com.apple.quicktime.make' || lk === 'com.apple.quicktime.model') return true;
      if (lk.startsWith('com.android.')) return true;
    }
  }
  return false;
}

/** The first creation_time tag value found across format/stream tags, if any. */
function creationTimeTag(input: VideoDetectionInput): string | undefined {
  for (const bag of allTagBags(input)) {
    const ct = bag['creation_time'];
    if (typeof ct === 'string' && ct.length > 0) return ct;
  }
  return undefined;
}

/**
 * True when there is no usable, non-epoch creation_time: either the tag is
 * absent, unparseable, or resolves to the Unix epoch / year 1970.
 */
function creationTimeMissingOrEpoch(input: VideoDetectionInput): boolean {
  const ct = creationTimeTag(input);
  if (!ct) return true;
  const d = new Date(ct);
  if (isNaN(d.getTime())) return true;
  return d.getUTCFullYear() <= 1970;
}

// ---------------------------------------------------------------------------
// Rule catalogs (data-driven)
// ---------------------------------------------------------------------------

/** Container-metadata rules — scanned against format + stream tags. */
const METADATA_RULES: DetectionRule[] = [
  {
    id: 'tt-comment-vid',
    platform: 'tiktok',
    source: 'metadata',
    confidence: 0.98,
    match: input => {
      const c = input.formatTags?.['comment'];
      return typeof c === 'string' && /^vid:v0[0-9a-z]/i.test(c);
    },
  },
  {
    id: 'tt-bytedance',
    platform: 'tiktok',
    source: 'metadata',
    confidence: 0.98,
    match: input => {
      for (const bag of allTagBags(input)) {
        for (const key of Object.keys(bag)) {
          const lk = key.toLowerCase();
          if (lk === 'aigc_info' || lk === 'com.bytedance.info') return true;
        }
      }
      return anyTagKeyOrValueContains(input, 'bytedance');
    },
  },
  {
    id: 'tt-handler',
    platform: 'tiktok',
    source: 'metadata',
    confidence: 0.95,
    match: input =>
      (input.streamTags ?? []).some(t => {
        const h = (t['handler_name'] ?? '').toLowerCase();
        return h.includes('bytedance') || h.includes('tiktok');
      }),
  },
  {
    id: 'tt-text',
    platform: 'tiktok',
    source: 'metadata',
    confidence: 0.9,
    match: input => {
      const ft = input.formatTags ?? {};
      return ['artist', 'description', 'copyright'].some(k => {
        const v = (ft[k] ?? '').toLowerCase();
        return v.includes('tiktok') || v.includes('douyin');
      });
    },
  },
  {
    id: 'ig-text',
    platform: 'instagram',
    source: 'metadata',
    confidence: 0.9,
    match: input => anyTagValueContains(input, 'instagram'),
  },
  {
    id: 'fb-text',
    platform: 'facebook',
    source: 'metadata',
    confidence: 0.9,
    match: input => anyTagValueContains(input, 'facebook'),
  },
];

/** Filename rules — matched against input.filename (case-insensitive unless noted). */
const FILENAME_RULES: DetectionRule[] = [
  {
    id: 'tt-fn-downloader',
    platform: 'tiktok',
    source: 'filename',
    confidence: 0.95,
    match: input => /(snaptik|ssstik|tikmate|musical(ly)?down|ttsave|tikdown|tiktokio)/i.test(fileName(input)),
  },
  {
    id: 'tt-fn-word',
    platform: 'tiktok',
    source: 'filename',
    confidence: 0.95,
    match: input => /(^|[\W_])tiktok([\W_]|$)/i.test(fileName(input)),
  },
  {
    id: 'tt-fn-bareid',
    platform: 'tiktok',
    source: 'filename',
    confidence: 0.7,
    match: input => /^7\d{18}\.(mp4|mov|webm)$/i.test(fileName(input)),
  },
  {
    id: 'ig-fn-downloader',
    platform: 'instagram',
    source: 'filename',
    confidence: 0.95,
    match: input => /(snapinsta|saveinsta|instasave|igram\.|storysaver|reelsav|fastdl)/i.test(fileName(input)),
  },
  {
    id: 'ig-fn-word',
    platform: 'instagram',
    source: 'filename',
    confidence: 0.95,
    match: input => /(^|[\W_])(instagram|ig_?reel)([\W_]|$)/i.test(fileName(input)),
  },
  {
    id: 'ig-fn-cdn',
    platform: 'instagram',
    source: 'filename',
    confidence: 0.75,
    // Case-sensitive: Instagram CDN filenames are literally "AQM…"/"AQN…".
    match: input => /^AQ[MN][\w-]{12,}\.mp4$/.test(fileName(input)),
  },
  {
    id: 'fb-fn-downloader',
    platform: 'facebook',
    source: 'filename',
    confidence: 0.95,
    match: input => /(fdown|fbdown|getfvid|fbvideo|fb_?video)/i.test(fileName(input)),
  },
  {
    id: 'fb-fn-word',
    platform: 'facebook',
    source: 'filename',
    confidence: 0.9,
    match: input => /(^|[\W_])facebook([\W_]|$)|^fb_?vid[\W_]/i.test(fileName(input)),
  },
  {
    id: 'gen-fn-downloader',
    platform: 'other',
    source: 'filename',
    confidence: 0.85,
    match: input => /(snapsave|savefrom|y2mate|videodownloader)/i.test(fileName(input)),
  },
];

/**
 * Suspicion heuristics — soft signals that only influence `recommendTier2`.
 * These NEVER yield a DetectionResult on their own.
 */
const SUSPICION_HEURISTICS: SuspicionHeuristic[] = [
  {
    id: 'heur-portrait-short',
    match: input => {
      const { height, width, durationMs } = input;
      if (!height || !width) return false;
      if (height / width < 1.6) return false;
      if (durationMs === undefined || durationMs > 180000) return false;
      if (hasDeviceCaptureTags(input)) return false;
      return creationTimeMissingOrEpoch(input);
    },
  },
  {
    id: 'heur-reshare-filename',
    match: input => {
      const name = fileName(input);
      return /^VID-\d{8}-WA\d{4}/i.test(name) || /^video_\d{4}-\d{2}-\d{2}[_ ]/i.test(name);
    },
  },
];

/** Normalize OCR text: lowercase, strip diacritics, collapse whitespace. */
function normalizeOcrText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Evaluate a rule/heuristic defensively — a throwing predicate counts as no match. */
function safeMatch(fn: (input: VideoDetectionInput) => boolean, input: VideoDetectionInput): boolean {
  try {
    return fn(input);
  } catch {
    return false;
  }
}

@Injectable()
export class SocialMediaDetectorService {
  /**
   * Tier-1 detection: evaluate all metadata + filename rules and pick the
   * highest-confidence match.
   *
   * - If the best match meets `minConfidence`, return it (method derived from the
   *   winning rule's source) with `recommendTier2: false`.
   * - Otherwise, if the best match sits in the grey zone `[0.6, minConfidence)`,
   *   OR any suspicion heuristic fires, return `{ result: null, recommendTier2: true }`
   *   so the caller runs the (more expensive) Tier-2 OCR pass.
   * - Otherwise, return `{ result: null, recommendTier2: false }`.
   */
  detectTier1(
    input: VideoDetectionInput,
    minConfidence = 0.8,
  ): { result: DetectionResult | null; recommendTier2: boolean } {
    let best: DetectionRule | null = null;
    for (const rule of [...METADATA_RULES, ...FILENAME_RULES]) {
      if (!safeMatch(rule.match, input)) continue;
      if (best === null || rule.confidence > best.confidence) best = rule;
    }

    if (best && best.confidence >= minConfidence) {
      return {
        result: {
          platform: best.platform,
          method: best.source === 'metadata' ? 'metadata' : 'filename',
          confidence: best.confidence,
          matchedRule: best.id,
        },
        recommendTier2: false,
      };
    }

    const inGreyZone = best !== null && best.confidence >= 0.6 && best.confidence < minConfidence;
    const suspicious = SUSPICION_HEURISTICS.some(h => safeMatch(h.match, input));

    if (inGreyZone || suspicious) {
      return { result: null, recommendTier2: true };
    }
    return { result: null, recommendTier2: false };
  }

  /**
   * Tier-2 detection from OCR text.
   *
   * `texts` are raw OCR strings; word-confidence filtering (e.g. discarding OCR
   * tokens below ~60% recognition confidence) happens in the OCR service BEFORE
   * calling this method — here we only reason over the provided strings.
   *
   * Platform words (tiktok/douyin, instagram, facebook) yield their rule
   * confidence.  A bare "reel(s)" mention only corroborates Instagram (0.60,
   * below threshold).  An @username token alone is weak (0.50), rising to 0.75
   * only when a suspicion heuristic also fired; when a platform word is present
   * the username merely reinforces that platform's existing confidence.
   *
   * Returns the highest-confidence platform result that meets `minConfidence`
   * (method 'ocr'), or null.
   */
  detectFromOcr(
    texts: string[],
    input: VideoDetectionInput,
    minConfidence = 0.8,
  ): DetectionResult | null {
    const joined = texts.map(normalizeOcrText).join(' \n ');

    const candidates: Array<{ platform: SocialPlatform; confidence: number; matchedRule: string }> = [];

    if (/tik\s?tok|douyin/.test(joined)) {
      candidates.push({ platform: 'tiktok', confidence: 0.9, matchedRule: 'ocr-tiktok-word' });
    }
    if (/instagram/.test(joined)) {
      candidates.push({ platform: 'instagram', confidence: 0.9, matchedRule: 'ocr-instagram-word' });
    }
    if (/facebook/.test(joined)) {
      candidates.push({ platform: 'facebook', confidence: 0.85, matchedRule: 'ocr-facebook-word' });
    }
    if (/\breels?\b/.test(joined)) {
      // Corroboration only — below threshold, so never a standalone result.
      candidates.push({ platform: 'instagram', confidence: 0.6, matchedRule: 'ocr-reels-corroborate' });
    }

    const hasUsername = /@[a-z0-9_.]{3,24}/.test(joined);
    if (hasUsername) {
      // A platform word already carries its rule confidence (the "boost"); an
      // @username adds nothing extra in that case.  With no platform word, the
      // username is weak on its own (0.50), capped at 0.75 when suspicion fired.
      const hasPlatformWord = candidates.some(c => c.matchedRule.endsWith('-word'));
      if (!hasPlatformWord) {
        const suspicious = SUSPICION_HEURISTICS.some(h => safeMatch(h.match, input));
        candidates.push({
          platform: 'other',
          confidence: suspicious ? 0.75 : 0.5,
          matchedRule: 'ocr-username',
        });
      }
    }

    let best: { platform: SocialPlatform; confidence: number; matchedRule: string } | null = null;
    for (const c of candidates) {
      if (best === null || c.confidence > best.confidence) best = c;
    }

    if (best && best.confidence >= minConfidence) {
      return {
        platform: best.platform,
        method: 'ocr',
        confidence: best.confidence,
        matchedRule: best.matchedRule,
      };
    }
    return null;
  }
}
