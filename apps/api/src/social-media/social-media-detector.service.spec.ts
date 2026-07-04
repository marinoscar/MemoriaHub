/**
 * Unit tests for SocialMediaDetectorService — the pure, zero-IO rule engine
 * behind social-media video detection.
 *
 * No DI / mocking needed: the service takes no constructor dependencies, so
 * every test instantiates it directly and feeds it a VideoDetectionInput.
 *
 * Coverage:
 *   - detectTier1: every METADATA_RULES and FILENAME_RULES entry (positive)
 *   - detectTier1: negatives (clean input, device-capture tags, grey zone,
 *     suspicion heuristics without a conclusive rule match)
 *   - detectFromOcr: platform words, corroboration-only signals, @username
 *     handling, and minConfidence boundary behavior
 */

import {
  SocialMediaDetectorService,
  VideoDetectionInput,
} from './social-media-detector.service';

describe('SocialMediaDetectorService', () => {
  let detector: SocialMediaDetectorService;

  beforeEach(() => {
    detector = new SocialMediaDetectorService();
  });

  function baseInput(overrides: Partial<VideoDetectionInput> = {}): VideoDetectionInput {
    return { kind: 'video', ...overrides };
  }

  // ---------------------------------------------------------------------------
  // detectTier1 — METADATA_RULES
  // ---------------------------------------------------------------------------
  describe('detectTier1 — metadata rules', () => {
    it('detects TikTok via formatTags.comment matching vid:v0... (tt-comment-vid)', () => {
      const input = baseInput({
        formatTags: { comment: 'vid:v09044g40000c1a2b3c4d5e6f7g8h9i0' },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'metadata',
        confidence: 0.98,
        matchedRule: 'tt-comment-vid',
      });
      expect(recommendTier2).toBe(false);
    });

    it('detects TikTok via an aigc_info key present in formatTags (tt-bytedance)', () => {
      const input = baseInput({
        formatTags: { aigc_info: 'some-tiktok-provenance-blob' },
      });

      const { result } = detector.detectTier1(input);

      expect(result).toMatchObject({
        platform: 'tiktok',
        method: 'metadata',
        matchedRule: 'tt-bytedance',
        confidence: 0.98,
      });
    });

    it('detects TikTok via a com.bytedance.info key present in streamTags (tt-bytedance)', () => {
      const input = baseInput({
        streamTags: [{ 'com.bytedance.info': '{}' }],
      });

      const { result } = detector.detectTier1(input);

      expect(result).toMatchObject({ platform: 'tiktok', matchedRule: 'tt-bytedance' });
    });

    it('detects TikTok via a tag VALUE containing "bytedance" (tt-bytedance)', () => {
      const input = baseInput({
        formatTags: { encoder: 'bytedance-video-encoder-1.0' },
      });

      const { result } = detector.detectTier1(input);

      expect(result).toMatchObject({ platform: 'tiktok', matchedRule: 'tt-bytedance' });
    });

    it('detects TikTok via streamTags handler_name containing "tiktok" (tt-handler)', () => {
      // Deliberately uses "tiktok" (not "bytedance") in handler_name so tt-bytedance's
      // substring check does not also fire and outrank this rule.
      const input = baseInput({
        streamTags: [{ handler_name: 'com.tiktok.videoenc' }],
      });

      const { result } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'metadata',
        confidence: 0.95,
        matchedRule: 'tt-handler',
      });
    });

    it('resolves to tt-bytedance (not tt-handler) when handler_name contains "bytedance", since tt-bytedance outranks it on confidence', () => {
      // Documents real precedence: both tt-handler (0.95) and tt-bytedance (0.98)
      // match when handler_name contains "bytedance" — the highest-confidence
      // rule wins. Not a bug; detectTier1 always picks the best match overall.
      const input = baseInput({
        streamTags: [{ handler_name: 'bytedance.videoenc' }],
      });

      const { result } = detector.detectTier1(input);

      expect(result?.matchedRule).toBe('tt-bytedance');
      expect(result?.confidence).toBe(0.98);
    });

    it('detects TikTok via artist tag containing "tiktok" (tt-text)', () => {
      const input = baseInput({ formatTags: { artist: 'TikTok' } });

      const { result } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'metadata',
        confidence: 0.9,
        matchedRule: 'tt-text',
      });
    });

    it('detects TikTok via description tag containing "douyin" (tt-text)', () => {
      const input = baseInput({ formatTags: { description: 'Exported from Douyin' } });

      const { result } = detector.detectTier1(input);

      expect(result).toMatchObject({ platform: 'tiktok', matchedRule: 'tt-text' });
    });

    it('detects TikTok via copyright tag containing "tiktok" (tt-text)', () => {
      const input = baseInput({ formatTags: { copyright: '(c) TikTok Pte. Ltd.' } });

      const { result } = detector.detectTier1(input);

      expect(result).toMatchObject({ platform: 'tiktok', matchedRule: 'tt-text' });
    });

    it('detects Instagram via a tag value containing "instagram" (ig-text)', () => {
      const input = baseInput({ formatTags: { comment: 'Shared from Instagram' } });

      const { result } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'instagram',
        method: 'metadata',
        confidence: 0.9,
        matchedRule: 'ig-text',
      });
    });

    it('detects Facebook via a tag value containing "facebook" (fb-text)', () => {
      const input = baseInput({ formatTags: { comment: 'Downloaded from Facebook' } });

      const { result } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'facebook',
        method: 'metadata',
        confidence: 0.9,
        matchedRule: 'fb-text',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // detectTier1 — FILENAME_RULES
  // ---------------------------------------------------------------------------
  describe('detectTier1 — filename rules', () => {
    it.each([
      ['tt-fn-downloader (snaptik)', 'snaptik_export_video.mp4', 'tiktok', 'tt-fn-downloader', 0.95, 0.8],
      ['tt-fn-downloader (ssstik)', 'ssstik.io_download.mp4', 'tiktok', 'tt-fn-downloader', 0.95, 0.8],
      ['tt-fn-word ("TikTok" word)', 'my_tiktok_video.mp4', 'tiktok', 'tt-fn-word', 0.95, 0.8],
      [
        'ig-fn-downloader (snapinsta)',
        'snapinsta_photo_export.mp4',
        'instagram',
        'ig-fn-downloader',
        0.95,
        0.8,
      ],
      [
        'ig-fn-word ("instagram")',
        'cool_instagram_reel.mp4',
        'instagram',
        'ig-fn-word',
        0.95,
        0.8,
      ],
      ['fb-fn-downloader (fdown)', 'fdown_clip_export.mp4', 'facebook', 'fb-fn-downloader', 0.95, 0.8],
      [
        'fb-fn-word ("facebook")',
        'my_facebook_clip.mp4',
        'facebook',
        'fb-fn-word',
        0.9,
        0.8,
      ],
      [
        'fb-fn-word ("FB_VID_" prefix)',
        'FB_VID_20260101_120000.mp4',
        'facebook',
        'fb-fn-word',
        0.9,
        0.8,
      ],
      [
        'gen-fn-downloader (snapsave -> other)',
        'snapsave_download_1080p.mp4',
        'other',
        'gen-fn-downloader',
        0.85,
        0.8,
      ],
    ])('%s', (_label, filename, platform, matchedRule, confidence, minConfidence) => {
      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename }),
        minConfidence,
      );

      expect(result).toEqual({ platform, method: 'filename', confidence, matchedRule });
      expect(recommendTier2).toBe(false);
    });

    it('detects the bare TikTok CDN id pattern 7\\d{18}.mp4 (tt-fn-bareid) when minConfidence is lowered to admit it', () => {
      const filename = `7${'2'.repeat(18)}.mp4`;
      expect(filename).toMatch(/^7\d{18}\.mp4$/);

      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename }),
        0.65,
      );

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'filename',
        confidence: 0.7,
        matchedRule: 'tt-fn-bareid',
      });
      expect(recommendTier2).toBe(false);
    });

    it('detects the Instagram CDN filename pattern AQM.../AQN... (ig-fn-cdn) when minConfidence is lowered to admit it', () => {
      const filename = 'AQMabcdefghijklmno.mp4';
      expect(filename).toMatch(/^AQM[\w-]{12,}\.mp4$/);

      const { result } = detector.detectTier1(baseInput({ filename }), 0.7);

      expect(result).toEqual({
        platform: 'instagram',
        method: 'filename',
        confidence: 0.75,
        matchedRule: 'ig-fn-cdn',
      });
    });

    it('ig-fn-cdn match is case-sensitive: lowercase "aqm..." does not match', () => {
      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename: 'aqmabcdefghijklmno.mp4' }),
        0.6,
      );

      expect(result).toBeNull();
      // No other rule/heuristic fires for this filename, so no tier-2 recommendation either.
      expect(recommendTier2).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // detectTier1 — negatives / must-not-detect
  // ---------------------------------------------------------------------------
  describe('detectTier1 — negatives (clean input, device tags, heuristics only)', () => {
    it('does not flag a plain camera-named file (IMG_1234.MOV) with no metadata', () => {
      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename: 'IMG_1234.MOV' }),
      );

      expect(result).toBeNull();
      expect(recommendTier2).toBe(false);
    });

    it('does not flag a video with Apple QuickTime device-capture tags', () => {
      const input = baseInput({
        filename: 'IMG_5678.MOV',
        formatTags: {
          'com.apple.quicktime.make': 'Apple',
          'com.apple.quicktime.model': 'iPhone 15 Pro',
          creation_time: '2026-06-01T10:00:00Z',
        },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(false);
    });

    it('recommends tier-2 (but does not detect) for a plain portrait, short, no-metadata video (heur-portrait-short)', () => {
      // 1080x1920 portrait, 60s, no tags at all → no usable creation_time →
      // suspicious portrait-short heuristic fires.
      const input = baseInput({ width: 1080, height: 1920, durationMs: 60000 });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(true);
    });

    it('does NOT fire heur-portrait-short when device-capture tags are present (real camera export)', () => {
      const input = baseInput({
        width: 1080,
        height: 1920,
        durationMs: 60000,
        formatTags: { 'com.apple.quicktime.make': 'Apple' },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(false);
    });

    it('recommends tier-2 (but does not detect) for a WhatsApp-style reshare filename (heur-reshare-filename)', () => {
      const input = baseInput({ filename: 'VID-20260101-WA0012.mp4' });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(true);
    });

    it('recommends tier-2 for a bare TikTok CDN id at the default minConfidence (grey zone: 0.6 <= 0.7 < 0.8)', () => {
      const filename = `7${'3'.repeat(18)}.mp4`;

      const { result, recommendTier2 } = detector.detectTier1(baseInput({ filename }));

      expect(result).toBeNull();
      expect(recommendTier2).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // detectFromOcr
  // ---------------------------------------------------------------------------
  describe('detectFromOcr', () => {
    it('detects TikTok from OCR text "TikTok" plus a corroborating @username', () => {
      const result = detector.detectFromOcr(['TikTok', '@grandma'], baseInput());

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'ocr',
        confidence: 0.9,
        matchedRule: 'ocr-tiktok-word',
      });
    });

    it('returns null for a bare @username with no platform word and no suspicion heuristic (weak signal, below threshold)', () => {
      const result = detector.detectFromOcr(['@grandma'], baseInput());

      expect(result).toBeNull();
    });

    it('boosts the @username-only signal to 0.75 when a suspicion heuristic also fires, but still below default threshold', () => {
      const input = baseInput({ filename: 'VID-20260101-WA0012.mp4' });

      const result = detector.detectFromOcr(['@grandma'], input);

      // 0.75 < default minConfidence 0.8 → still null...
      expect(result).toBeNull();
      // ...but detectable once minConfidence is lowered to admit it.
      const lowered = detector.detectFromOcr(['@grandma'], input, 0.75);
      expect(lowered).toEqual({
        platform: 'other',
        method: 'ocr',
        confidence: 0.75,
        matchedRule: 'ocr-username',
      });
    });

    it('returns null for a bare "reels" mention alone (corroboration-only, below threshold)', () => {
      const result = detector.detectFromOcr(['reels'], baseInput());

      expect(result).toBeNull();
    });

    it('detects Instagram from OCR text containing "instagram"', () => {
      const result = detector.detectFromOcr(['Shared via Instagram'], baseInput());

      expect(result).toEqual({
        platform: 'instagram',
        method: 'ocr',
        confidence: 0.9,
        matchedRule: 'ocr-instagram-word',
      });
    });

    it('detects Facebook from OCR text containing "facebook"', () => {
      const result = detector.detectFromOcr(['facebook'], baseInput());

      expect(result).toEqual({
        platform: 'facebook',
        method: 'ocr',
        confidence: 0.85,
        matchedRule: 'ocr-facebook-word',
      });
    });

    it('an @username does not add a separate candidate when a platform word is already present', () => {
      // hasPlatformWord short-circuits the username candidate — the platform
      // word's own confidence (0.9) is used as-is, not boosted or replaced.
      const result = detector.detectFromOcr(['tiktok @someuser123'], baseInput());

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'ocr',
        confidence: 0.9,
        matchedRule: 'ocr-tiktok-word',
      });
    });

    describe('minConfidence boundary behavior', () => {
      it('detects facebook (0.85) when minConfidence is exactly 0.85 (inclusive boundary)', () => {
        const result = detector.detectFromOcr(['facebook'], baseInput(), 0.85);
        expect(result).not.toBeNull();
        expect(result?.platform).toBe('facebook');
      });

      it('rejects facebook (0.85) when minConfidence is raised to 0.9', () => {
        const result = detector.detectFromOcr(['facebook'], baseInput(), 0.9);
        expect(result).toBeNull();
      });

      it('accepts a lower-confidence signal when minConfidence is lowered accordingly', () => {
        const result = detector.detectFromOcr(['reels'], baseInput(), 0.6);
        expect(result).toEqual({
          platform: 'instagram',
          method: 'ocr',
          confidence: 0.6,
          matchedRule: 'ocr-reels-corroborate',
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // detectCaptionSignal / detectTier1 — caption & hashtag/mention detection
  //
  // Download apps name saved files after the post caption (and sometimes stuff
  // the caption into container text tags), so a hashtag / @mention / platform
  // token in either place is a high-precision social-media signal that the
  // generic metadata/filename rules above miss entirely.
  // ---------------------------------------------------------------------------
  describe('caption/hashtag signal — detectTier1 positives (real-world captions)', () => {
    it('detects the real-world example caption filename as TikTok (3 tt tokens outrank 1 ig token)', () => {
      const filename =
        'Every man wants this!! #fypシ #reels #dating #emilywking #relationshipadvice @empoweredtok on TT.mp4';
      const input = baseInput({ filename });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-tt-token',
      });
      expect(recommendTier2).toBe(false);

      // Direct precision check: the caption signal alone (no other rule involved)
      // produces the exact same result.
      expect(detector.detectCaptionSignal(input)).toEqual(result);
    });

    it('detects a lone "#reels" in the filename as Instagram (caption-ig-token)', () => {
      const { result } = detector.detectTier1(baseInput({ filename: 'myvid #reels.mp4' }));

      expect(result).toEqual({
        platform: 'instagram',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-ig-token',
      });
    });

    it('detects a lone "#fyp" in the filename as TikTok (caption-tt-token)', () => {
      const { result } = detector.detectTier1(baseInput({ filename: 'clip #fyp.mp4' }));

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-tt-token',
      });
    });

    it('detects the phrase "on TT" in the filename as TikTok (caption-tt-token)', () => {
      const { result } = detector.detectTier1(baseInput({ filename: 'party clip on TT.mp4' }));

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-tt-token',
      });
    });

    it('detects an "@...tok" handle in the filename as TikTok (caption-tt-token)', () => {
      const { result } = detector.detectTier1(baseInput({ filename: '@something_tok.mp4' }));

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-tt-token',
      });
    });

    it('detects a caption stuffed into container metadata (description tag), not the filename, via 2 hashtags (caption-generic)', () => {
      const input = baseInput({
        filename: 'video.mp4',
        formatTags: { description: 'love this #summer #vacation @friend' },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toEqual({
        platform: 'other',
        method: 'metadata',
        confidence: 0.9,
        matchedRule: 'caption-generic',
      });
      expect(recommendTier2).toBe(false);
    });

    it('detects a generic caption filename with 2 hashtags and no platform token (caption-generic)', () => {
      const { result } = detector.detectTier1(
        baseInput({ filename: 'Best day ever #love #family.mp4' }),
      );

      expect(result).toEqual({
        platform: 'other',
        method: 'filename',
        confidence: 0.9,
        matchedRule: 'caption-generic',
      });
    });

    it('detects a single lone hashtag in the filename (caption-single-hashtag) at confidence 0.85', () => {
      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename: 'sunset #golden.mp4' }),
      );

      expect(result).toEqual({
        platform: 'other',
        method: 'filename',
        confidence: 0.85,
        matchedRule: 'caption-single-hashtag',
      });
      expect(recommendTier2).toBe(false);
    });
  });

  describe('caption/hashtag signal — negatives (must not classify)', () => {
    it.each([
      ['Take #2.mp4'],
      ['Photo #1.mp4'],
      ['Birthday #3.mov'],
    ])(
      'treats a purely numeric hashtag as no signal at all: %s (precision regression guard)',
      filename => {
        const { result, recommendTier2 } = detector.detectTier1(baseInput({ filename }));

        expect(result).toBeNull();
        expect(recommendTier2).toBe(false);
        // Direct precision check: the numeric hashtag never produces a caption
        // candidate in the first place (not just suppressed downstream).
        expect(detector.detectCaptionSignal(baseInput({ filename }))).toBeNull();
      },
    );

    it.each([['PXL_20260704_120000.mp4'], ['MVI_0031.MOV'], ['C0001.MP4']])(
      'does not flag a plain camera-named file with no hashtag/mention: %s',
      filename => {
        const { result, recommendTier2 } = detector.detectTier1(baseInput({ filename }));

        expect(result).toBeNull();
        expect(recommendTier2).toBe(false);
      },
    );

    it('does not flag camera-descriptive text stuffed in title/comment tags (no hashtag/mention present)', () => {
      const input = baseInput({
        filename: 'clip.mp4',
        formatTags: { title: 'iPhone', comment: 'GoPro' },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(false);
    });

    it('does not classify a plain multi-word filename with no hashtag or mention (multi-word phrase alone is not enough)', () => {
      const { result, recommendTier2 } = detector.detectTier1(
        baseInput({ filename: 'Family vacation 2026.mp4' }),
      );

      expect(result).toBeNull();
      expect(recommendTier2).toBe(false);
    });
  });

  describe('caption/hashtag signal — tier-2 routing for a lone @mention (heur-caption-mention)', () => {
    it('routes a lone @mention filename (no hashtag, no platform token) to tier-2 OCR without classifying it', () => {
      const { result, recommendTier2 } = detector.detectTier1(baseInput({ filename: '@home.mp4' }));

      expect(result).toBeNull();
      expect(recommendTier2).toBe(true);
    });

    it('routes a lone @mention found only in container metadata (no hashtag) to tier-2 OCR without classifying it', () => {
      const input = baseInput({
        filename: 'clip.mp4',
        formatTags: { comment: 'follow @someone' },
      });

      const { result, recommendTier2 } = detector.detectTier1(input);

      expect(result).toBeNull();
      expect(recommendTier2).toBe(true);
    });
  });

  describe('detectFromOcr — platform-token candidates (caption tokens on-screen)', () => {
    it('detects Instagram from a bare "#reels" OCR token (ocr-instagram-token)', () => {
      const result = detector.detectFromOcr(['#reels'], baseInput());

      expect(result).toEqual({
        platform: 'instagram',
        method: 'ocr',
        confidence: 0.9,
        matchedRule: 'ocr-instagram-token',
      });
    });

    it('detects TikTok from a bare "@creator_tok" OCR handle (ocr-tiktok-token)', () => {
      const result = detector.detectFromOcr(['@creator_tok'], baseInput());

      expect(result).toEqual({
        platform: 'tiktok',
        method: 'ocr',
        confidence: 0.9,
        matchedRule: 'ocr-tiktok-token',
      });
    });

    it('still returns null for a plain "@grandma" OCR mention with no platform token/word (no regression)', () => {
      const result = detector.detectFromOcr(['@grandma'], baseInput());

      expect(result).toBeNull();
    });
  });
});
