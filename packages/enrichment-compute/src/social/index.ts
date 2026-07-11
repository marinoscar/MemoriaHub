/**
 * Social-media video detection — pure rule engine (moved VERBATIM from
 * apps/api/src/social-media/social-media-detector.service.ts).
 *
 * Classifies whether a video was downloaded/re-shared from a social-media
 * platform (TikTok, Instagram, Facebook) based on container metadata, filename,
 * and (optionally) OCR text. Zero-IO, synchronous, dependency-free — no
 * database access, no network/disk IO — so the exact same catalog runs on the
 * server (via the API's thin SocialMediaDetectorService adapter) and on a
 * distributed worker node (docs/specs/distributed-nodes.md §7: one rule
 * catalog, two hosts, identical verdicts for identical inputs).
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
// Caption-signal helpers
// ---------------------------------------------------------------------------
//
// Download apps name the saved file after the post caption and sometimes stuff
// the caption into container text tags too, e.g.
//   "Every man wants this!! #fyp #reels @empoweredtok on TT.mp4"
// Personal camera footage filenames NEVER contain hashtags or @mentions (they
// are "IMG_1234.MOV", "PXL_20260704_120000.mp4", "VID-20260704-WA0001.mp4",
// "MVI_0031.MOV").  So a hashtag or @mention — in the filename OR in a container
// text tag — is a high-precision social-media signal.

/** Container tag keys download apps commonly stuff a post caption into. */
const TEXT_TAG_KEYS = ['title', 'comment', 'description', 'synopsis', 'keywords', 'artist', 'album', 'author'];

/**
 * The two caption text sources for an input:
 * - `filenameText`: the raw filename (download apps name files after the caption).
 * - `metaText`: caption text harvested from container tags — the TEXT_TAG_KEYS
 *   values of the format bag PLUS, to be robust, ALL values of every stream tag
 *   bag (a caption may land in an unexpected stream tag), space-joined.
 */
function captionSources(input: VideoDetectionInput): { filenameText: string; metaText: string } {
  const parts: string[] = [];
  const ft = input.formatTags ?? {};
  for (const key of TEXT_TAG_KEYS) {
    const v = ft[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  for (const bag of input.streamTags ?? []) {
    for (const v of Object.values(bag)) {
      if (typeof v === 'string' && v.length > 0) parts.push(v);
    }
  }
  return { filenameText: fileName(input), metaText: parts.join(' ') };
}

/** Unicode hashtag token: '#' followed by ≥1 letter/number/underscore. */
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

/**
 * Number of hashtag tokens in `text` that contain at least one Unicode letter.
 *
 * Purely-numeric/underscore hashtags (`#1`, `#23`, `#_`) are excluded by design:
 * real social hashtags always contain a letter (`#reels`, `#fyp`, `#dating`,
 * `#fypシ`), whereas "number N" filenames (`Take #2.mp4`, `Photo #1.mp4`,
 * `Birthday #3.mov`) do not — counting those would cause false positives.
 */
function countHashtags(text: string): number {
  const m = text.match(HASHTAG_RE);
  if (!m) return 0;
  return m.filter(tag => /\p{L}/u.test(tag)).length;
}

/** @mention token: '@' followed by 2–30 of [a-z0-9_.] (case-insensitive). */
const MENTION_RE = /@[a-z0-9_.]{2,30}/gi;

/** True if `text` contains an @mention token. */
function hasMention(text: string): boolean {
  MENTION_RE.lastIndex = 0; // reset — MENTION_RE carries the global flag.
  return MENTION_RE.test(text);
}

/**
 * Per-platform caption/OCR token patterns (case-insensitive, non-global so
 * `.test()` is stateless).  These are distinctive social-media hashtags/phrases,
 * not generic words — high precision by construction.
 */
const PLATFORM_TOKEN_PATTERNS: Record<'tiktok' | 'instagram' | 'facebook', RegExp[]> = {
  // `#fyp` is a prefix, so `#fypシ`, `#fypage`, `#foryou`, `#foryoupage` all hit.
  tiktok: [/#fyp|#foryou/i, /#tiktok\b/i, /#ttok\b/i, /#capcut\b/i, /\bon tt\b/i, /@[a-z0-9_.]*tok\b/i],
  instagram: [/#reels?\b/i, /#instagram\b/i, /#igreel\b/i, /#insta\b/i, /\big reel/i],
  facebook: [/#facebook\b/i, /#fbreels?\b/i, /\bfb reel/i],
};

/**
 * Count how many of each platform's token patterns fire in `text`.  Counts
 * patterns that match (not total occurrences) — simpler, and enough to rank the
 * most-likely platform.
 */
function platformTokenHits(text: string): { tiktok: number; instagram: number; facebook: number } {
  const count = (pats: RegExp[]): number => pats.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
  return {
    tiktok: count(PLATFORM_TOKEN_PATTERNS.tiktok),
    instagram: count(PLATFORM_TOKEN_PATTERNS.instagram),
    facebook: count(PLATFORM_TOKEN_PATTERNS.facebook),
  };
}

/** Pick the most-hit platform; tie-break order tiktok > instagram > facebook. */
function pickPlatform(hits: {
  tiktok: number;
  instagram: number;
  facebook: number;
}): 'tiktok' | 'instagram' | 'facebook' {
  const ordered: Array<['tiktok' | 'instagram' | 'facebook', number]> = [
    ['tiktok', hits.tiktok],
    ['instagram', hits.instagram],
    ['facebook', hits.facebook],
  ];
  let best = ordered[0];
  for (const entry of ordered) {
    if (entry[1] > best[1]) best = entry; // strictly-greater keeps the earlier on ties
  }
  return best[0];
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
  {
    // A lone @mention (no hashtag, no platform token) in the filename or caption
    // tags is weak on its own — don't auto-classify it (see detectCaptionSignal
    // case (d)); route it to the Tier-2 OCR pass instead.
    id: 'heur-caption-mention',
    match: input => {
      const { filenameText, metaText } = captionSources(input);
      return [filenameText, metaText].some(text => {
        if (!text) return false;
        const hits = platformTokenHits(text);
        const hasPlatformToken = hits.tiktok + hits.instagram + hits.facebook > 0;
        return hasMention(text) && countHashtags(text) === 0 && !hasPlatformToken;
      });
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

// ---------------------------------------------------------------------------
// Public detection API (pure functions — the API service and the CLI node
// worker both delegate here)
// ---------------------------------------------------------------------------

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
export function detectTier1(
  input: VideoDetectionInput,
  minConfidence = 0.8,
): { result: DetectionResult | null; recommendTier2: boolean } {
  let bestRule: DetectionRule | null = null;
  for (const rule of [...METADATA_RULES, ...FILENAME_RULES]) {
    if (!safeMatch(rule.match, input)) continue;
    if (bestRule === null || rule.confidence > bestRule.confidence) bestRule = rule;
  }

  // Normalize the winning rule (if any) into a DetectionResult candidate so it
  // competes on confidence against the caption signal below.
  let best: DetectionResult | null = bestRule
    ? {
        platform: bestRule.platform,
        method: bestRule.source === 'metadata' ? 'metadata' : 'filename',
        confidence: bestRule.confidence,
        matchedRule: bestRule.id,
      }
    : null;

  // Fold in the caption signal (hashtags / @mentions / platform tokens in the
  // filename or container text tags); it competes like any other candidate.
  const caption = detectCaptionSignal(input);
  if (caption && (best === null || caption.confidence > best.confidence)) {
    best = caption;
  }

  if (best && best.confidence >= minConfidence) {
    return { result: best, recommendTier2: false };
  }

  const inGreyZone = best !== null && best.confidence >= 0.6 && best.confidence < minConfidence;
  const suspicious = SUSPICION_HEURISTICS.some(h => safeMatch(h.match, input));

  if (inGreyZone || suspicious) {
    return { result: null, recommendTier2: true };
  }
  return { result: null, recommendTier2: false };
}

/**
 * Caption-signal detection — a high-precision Tier-1 companion.
 *
 * Download apps name the saved file after the post caption (and sometimes copy
 * the caption into container text tags), so hashtags / @mentions / platform
 * tokens there are a strong social-media signal that generic filename/metadata
 * rules miss (e.g. cross-posted Instagram/TikTok downloads).
 *
 * The filename is analyzed FIRST, then the container caption tags, so the
 * returned `method` is attributed correctly.  For each non-empty source:
 * - (a) any platform token → the most-hit platform (tie-break tt > ig > fb) at
 *   0.9, `matchedRule: 'caption-<tt|ig|fb>-token'`.
 * - (b) a clear generic caption (≥2 hashtags, or ≥1 hashtag with an @mention,
 *   or ≥1 hashtag alongside a multi-word phrase) → platform 'other' at 0.9,
 *   `matchedRule: 'caption-generic'`.
 * - (c) exactly one lone hashtag → platform 'other' at 0.85,
 *   `matchedRule: 'caption-single-hashtag'`.
 * - (d) an @mention only (no hashtag, no platform token) → NOT returned here;
 *   the `heur-caption-mention` suspicion heuristic routes it to Tier-2 OCR.
 *
 * Returns the first source's DetectionResult, or null when neither source
 * produced one.
 */
export function detectCaptionSignal(input: VideoDetectionInput): DetectionResult | null {
  const { filenameText, metaText } = captionSources(input);
  const sources: Array<{ text: string; method: DetectionMethod }> = [
    { text: filenameText, method: 'filename' },
    { text: metaText, method: 'metadata' },
  ];

  for (const { text, method } of sources) {
    if (!text) continue;

    const hits = platformTokenHits(text);
    const hashtags = countHashtags(text);
    const mention = hasMention(text);

    // (a) Explicit platform token → attribute to the most-hit platform.
    if (hits.tiktok + hits.instagram + hits.facebook > 0) {
      const platform = pickPlatform(hits);
      const suffix = platform === 'tiktok' ? 'tt' : platform === 'instagram' ? 'ig' : 'fb';
      return { platform, method, confidence: 0.9, matchedRule: `caption-${suffix}-token` };
    }

    // (b) Strong generic caption signal — no platform token, but clearly a
    //     caption (multiple hashtags, or a hashtag plus a mention/phrase).
    const multiWordPhrase = /[a-z]{2,}\s+[a-z]{2,}/i.test(text);
    if (hashtags >= 2 || (hashtags >= 1 && mention) || (hashtags >= 1 && multiWordPhrase)) {
      return { platform: 'other', method, confidence: 0.9, matchedRule: 'caption-generic' };
    }

    // (c) A single lone hashtag — weaker, but still a social signal.
    if (hashtags === 1) {
      return { platform: 'other', method, confidence: 0.85, matchedRule: 'caption-single-hashtag' };
    }

    // (d) Mention-only → fall through (handled by heur-caption-mention).
  }

  return null;
}

/**
 * Tier-2 detection from OCR text.
 *
 * `texts` are raw OCR strings; word-confidence filtering (e.g. discarding OCR
 * tokens below ~60% recognition confidence) happens in the OCR engine BEFORE
 * calling this function — here we only reason over the provided strings.
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
export function detectFromOcr(
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

  // Distinctive on-screen platform tokens (e.g. a "#reels" watermark or an
  // "@user…tok" handle) count as strong per-platform candidates too.
  const tokenHits = platformTokenHits(joined);
  if (tokenHits.tiktok > 0) {
    candidates.push({ platform: 'tiktok', confidence: 0.9, matchedRule: 'ocr-tiktok-token' });
  }
  if (tokenHits.instagram > 0) {
    candidates.push({ platform: 'instagram', confidence: 0.9, matchedRule: 'ocr-instagram-token' });
  }
  if (tokenHits.facebook > 0) {
    candidates.push({ platform: 'facebook', confidence: 0.9, matchedRule: 'ocr-facebook-token' });
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

// ---------------------------------------------------------------------------
// OCR frame-timestamp planning (moved from
// apps/api/src/social-media/social-media-ocr.service.ts)
// ---------------------------------------------------------------------------

/**
 * Compute the frame timestamps (ms) to OCR. Social watermarks/usernames tend to
 * sit near the very start and end of a re-shared clip, so we bias sampling to
 * both ends. Capped at `maxFrames`; callers dedupe/clamp via extractFramesAt.
 */
export function computeOcrTimestamps(
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
