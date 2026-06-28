/**
 * Unit tests for social-detectors.ts (pure module, no DI).
 *
 * Tests the detectSocial() function, platform detectors, and the registry
 * extension contract. No mocks needed — this module is pure TypeScript.
 */

import {
  detectSocial,
  SocialSignals,
  PLATFORM_DETECTORS,
  SOCIAL_MAIN_TAG,
  ALL_SYSTEM_TAG_NAMES,
  valueIncludes,
} from './social-detectors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignals(overrides: Partial<SocialSignals> = {}): SocialSignals {
  return {
    filename: 'video.mp4',
    storageName: 'video.mp4',
    containerTags: {},
    hasCameraMake: false,
    hasCameraModel: false,
    hasGps: false,
    hasContainerCreationTime: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// valueIncludes helper
// ---------------------------------------------------------------------------

describe('valueIncludes', () => {
  // Note: containerTags values are already lowercased by VideoProbeProcessor;
  // the function lowercases the substr so the search is case-insensitive on
  // the substr side. The values are expected to arrive pre-lowercased.
  it('returns true when any value contains the substring (value already lowercased)', () => {
    expect(valueIncludes({ encoder: 'tiktok_encoder_1.0', other: 'nope' }, 'tiktok')).toBe(true);
  });

  it('returns false when no value matches', () => {
    expect(valueIncludes({ encoder: 'ffmpeg', other: 'lavf' }, 'tiktok')).toBe(false);
  });

  it('handles empty tags', () => {
    expect(valueIncludes({}, 'tiktok')).toBe(false);
  });

  it('lowercases the substr so a mixed-case substr still matches a lowercase value', () => {
    // The production code lowercases the substr; values are pre-lowercased by the processor.
    expect(valueIncludes({ title: 'instagram' }, 'INSTAGRAM')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALL_SYSTEM_TAG_NAMES
// ---------------------------------------------------------------------------

describe('ALL_SYSTEM_TAG_NAMES', () => {
  it('contains SOCIAL_MAIN_TAG ("Social Media")', () => {
    expect(ALL_SYSTEM_TAG_NAMES).toContain(SOCIAL_MAIN_TAG);
  });

  it('contains all platform tag names', () => {
    for (const det of PLATFORM_DETECTORS) {
      expect(ALL_SYSTEM_TAG_NAMES).toContain(det.tagName);
    }
  });

  it('has unique entries', () => {
    const unique = new Set(ALL_SYSTEM_TAG_NAMES);
    expect(unique.size).toBe(ALL_SYSTEM_TAG_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// Platform-specific positive detections
// ---------------------------------------------------------------------------

describe('detectSocial — platform positives', () => {
  describe('TikTok', () => {
    it('detects 19-digit numeric filename', () => {
      const s = makeSignals({ filename: '7289341056123456789.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('tiktok');
      expect(r.tagNames).toContain(SOCIAL_MAIN_TAG);
      expect(r.tagNames).toContain('TikTok');
    });

    it('detects "tiktok" keyword in filename', () => {
      const s = makeSignals({ filename: 'tiktok_clip.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('tiktok');
    });

    it('detects "tiktok" in containerTags value', () => {
      const s = makeSignals({ containerTags: { encoder: 'tiktok_encoder_v3' } });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('tiktok');
    });

    it('detects "tiktok" keyword in ocrText', () => {
      const s = makeSignals({ ocrText: 'check out my tiktok for more' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('tiktok');
    });

    it('detects @handle pattern in ocrText', () => {
      const s = makeSignals({ ocrText: 'follow me @janedoe99 for updates' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('tiktok');
    });

    it('returns tagNames with both Social Media and TikTok', () => {
      const s = makeSignals({ filename: '7289341056123456789.mp4' });
      const r = detectSocial(s);
      expect(r.tagNames).toEqual(expect.arrayContaining([SOCIAL_MAIN_TAG, 'TikTok']));
    });
  });

  describe('Instagram', () => {
    it('detects "instagram" in filename', () => {
      const s = makeSignals({ filename: 'instagram_reel_2024.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('instagram');
      expect(r.tagNames).toContain(SOCIAL_MAIN_TAG);
      expect(r.tagNames).toContain('Instagram');
    });

    it('detects "reels" in filename', () => {
      const s = makeSignals({ filename: 'reels_highlights.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('instagram');
    });

    it('detects video_<digits> filename prefix', () => {
      const s = makeSignals({ filename: 'video_1234567890.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('instagram');
    });

    it('detects "instagram" in containerTags value', () => {
      const s = makeSignals({ containerTags: { title: 'instagram creator studio' } });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('instagram');
    });

    it('detects "instagram" in ocrText', () => {
      const s = makeSignals({ ocrText: 'see full video on instagram reels' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('instagram');
    });
  });

  describe('Facebook', () => {
    it('detects "facebook" in filename', () => {
      const s = makeSignals({ filename: 'facebook_video_2024.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('facebook');
      expect(r.tagNames).toContain(SOCIAL_MAIN_TAG);
      expect(r.tagNames).toContain('Facebook');
    });

    it('detects "fb_" prefix in filename', () => {
      const s = makeSignals({ filename: 'fb_123456789.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('facebook');
    });

    it('detects "facebook" in containerTags value', () => {
      const s = makeSignals({ containerTags: { comment: 'shared via facebook' } });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('facebook');
    });
  });

  describe('WhatsApp', () => {
    it('detects VID-YYYYMMDD-WA pattern in filename', () => {
      const s = makeSignals({ filename: 'VID-20260101-WA0007.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('whatsapp');
      expect(r.tagNames).toContain(SOCIAL_MAIN_TAG);
      expect(r.tagNames).toContain('WhatsApp');
    });

    it('detects "whatsapp" in filename', () => {
      const s = makeSignals({ filename: 'whatsapp_video.mp4' });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('whatsapp');
    });

    it('detects "whatsapp" in containerTags', () => {
      const s = makeSignals({ containerTags: { comment: 'whatsapp video' } });
      const r = detectSocial(s);
      expect(r.detected).toBe(true);
      expect(r.platform).toBe('whatsapp');
    });
  });
});

// ---------------------------------------------------------------------------
// Camera-original negative (should NOT be detected)
// ---------------------------------------------------------------------------

describe('detectSocial — camera-original negative', () => {
  it('does not detect a typical Pixel camera video', () => {
    const s = makeSignals({
      filename: 'PXL_20240101_120000.mp4',
      hasCameraMake: true,
      hasCameraModel: true,
      hasGps: true,
      hasContainerCreationTime: true,
      aspectRatio: 16 / 9,   // landscape
      codec: 'h264',
      width: 1920,
      height: 1080,
    });
    const r = detectSocial(s);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThan(3);
  });

  it('does not detect a DSC-prefixed camera recording', () => {
    const s = makeSignals({
      filename: 'DSC_0001.MOV',
      hasCameraMake: true,
      hasCameraModel: true,
      hasGps: false,
      hasContainerCreationTime: true,
      aspectRatio: 1.78,
    });
    const r = detectSocial(s);
    expect(r.detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggressive generic detection (no platform, score >= 3)
// ---------------------------------------------------------------------------

describe('detectSocial — generic social (no platform)', () => {
  it('detects a vertical, no-camera, no-GPS, Lavf-encoded file as generic social', () => {
    const s = makeSignals({
      filename: '1234567890abcdef.mp4',     // no known prefix, numeric-ish
      hasCameraMake: false,
      hasCameraModel: false,
      hasGps: false,
      hasContainerCreationTime: false,
      aspectRatio: 0.5625,                  // 9:16 portrait
      codec: 'h264',
      width: 1080,
      height: 1920,
      containerTags: { encoder: 'Lavf58.29.100' },
    });
    const r = detectSocial(s);
    expect(r.detected).toBe(true);
    expect(r.platform).toBeNull();
    expect(r.tagNames).toContain(SOCIAL_MAIN_TAG);
    expect(r.tagNames).not.toContain('TikTok');
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it('accumulates enough score even without Lavf encoder when other signals present', () => {
    // portrait + no camera + no gps + no creation_time = 2+2+1+1 = 6
    const s = makeSignals({
      filename: '9876543210.mp4',
      hasCameraMake: false,
      hasCameraModel: false,
      hasGps: false,
      hasContainerCreationTime: false,
      aspectRatio: 0.55,
    });
    const r = detectSocial(s);
    expect(r.detected).toBe(true);
    expect(r.platform).toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// OCR-only path: clean metadata but ocrText gives platform match
// ---------------------------------------------------------------------------

describe('detectSocial — OCR-only platform override', () => {
  it('matches TikTok via ocrText even when metadata is clean (camera-like)', () => {
    const s = makeSignals({
      filename: 'clip001.mp4',       // generic name
      hasCameraMake: true,
      hasCameraModel: true,
      hasGps: true,
      hasContainerCreationTime: true,
      ocrText: 'follow us on tiktok for daily videos',
    });
    const r = detectSocial(s);
    expect(r.detected).toBe(true);
    expect(r.platform).toBe('tiktok');
  });
});

// ---------------------------------------------------------------------------
// Platform detector registry extensibility
// ---------------------------------------------------------------------------

describe('PLATFORM_DETECTORS — registry extensibility', () => {
  it('supports adding a custom "twitter" detector without modifying existing ones', () => {
    // Copy the array so we don't mutate the module-level registry
    const extendedDetectors = [
      ...PLATFORM_DETECTORS,
      {
        key: 'twitter',
        tagName: 'Twitter',
        match(s: SocialSignals): boolean {
          if (/twitter|x\.com/i.test(s.filename)) return true;
          if (valueIncludes(s.containerTags, 'twitter') || valueIncludes(s.containerTags, 'x.com')) return true;
          if (s.ocrText && s.ocrText.includes('twitter')) return true;
          return false;
        },
      },
    ];

    // Should not affect original PLATFORM_DETECTORS length
    expect(extendedDetectors.length).toBe(PLATFORM_DETECTORS.length + 1);

    // Simulate detection with the extended array
    const signals = makeSignals({ filename: 'twitter_clip.mp4' });
    const matched = extendedDetectors.find((d) => d.match(signals));
    expect(matched).toBeDefined();
    expect(matched?.key).toBe('twitter');
    expect(matched?.tagName).toBe('Twitter');
  });

  it('original PLATFORM_DETECTORS is unmodified after extension smoke test', () => {
    // Sanity: the original registry still has the original 4 detectors
    const keys = PLATFORM_DETECTORS.map((d) => d.key);
    expect(keys).toEqual(['tiktok', 'instagram', 'facebook', 'whatsapp']);
  });
});
