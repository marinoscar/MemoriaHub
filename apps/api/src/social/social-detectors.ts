// Social media video detector registry (pure module, no Nest DI)

export interface SocialSignals {
  filename: string;
  storageName: string;
  containerTags: Record<string, string>;
  codec?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  hasCameraMake: boolean;
  hasCameraModel: boolean;
  hasGps: boolean;
  hasContainerCreationTime: boolean;
  aspectRatio?: number;
  ocrText?: string;
}

export interface PlatformDetector {
  key: string;
  tagName: string;
  match(s: SocialSignals): boolean;
}

/** Returns true if any container-tag VALUE contains substr (case-insensitive, already lowercased). */
export function valueIncludes(tags: Record<string, string>, substr: string): boolean {
  const lower = substr.toLowerCase();
  return Object.values(tags).some((v) => v.includes(lower));
}

export const SOCIAL_MAIN_TAG = 'Social Media';

export const PLATFORM_DETECTORS: PlatformDetector[] = [
  {
    key: 'tiktok',
    tagName: 'TikTok',
    match(s) {
      if (/^\d{19}(\.mp4)?$/i.test(s.filename) || /tiktok|musical/i.test(s.filename)) return true;
      if (valueIncludes(s.containerTags, 'tiktok') || valueIncludes(s.containerTags, 'musical')) return true;
      if (s.ocrText && (s.ocrText.includes('tiktok') || /@[a-z0-9._]{2,30}/.test(s.ocrText))) return true;
      return false;
    },
  },
  {
    key: 'instagram',
    tagName: 'Instagram',
    match(s) {
      if (/instagram|reels?|^video_\d+/i.test(s.filename)) return true;
      if (valueIncludes(s.containerTags, 'instagram') || valueIncludes(s.containerTags, 'reel')) return true;
      if (s.ocrText && (s.ocrText.includes('instagram') || s.ocrText.includes('reels'))) return true;
      return false;
    },
  },
  {
    key: 'facebook',
    tagName: 'Facebook',
    match(s) {
      if (/facebook|^fb_|fbdownloader/i.test(s.filename)) return true;
      if (valueIncludes(s.containerTags, 'facebook')) return true;
      return false;
    },
  },
  {
    key: 'whatsapp',
    tagName: 'WhatsApp',
    match(s) {
      if (/^vid-\d{8}-wa\d+/i.test(s.filename)) return true;
      if (/whatsapp/i.test(s.filename)) return true;
      if (valueIncludes(s.containerTags, 'whatsapp')) return true;
      return false;
    },
  },
];

export const ALL_SYSTEM_TAG_NAMES: string[] = [
  SOCIAL_MAIN_TAG,
  ...PLATFORM_DETECTORS.map((d) => d.tagName),
];

export interface DetectionResult {
  detected: boolean;
  platform: string | null;
  tagNames: string[];
  score: number;
}

/**
 * Detect whether a video is likely sourced from social media.
 *
 * 1. Run platform detectors in order — first match wins.
 * 2. If no platform match, compute aggressive generic score.
 *    Score >= 3 → generic social media detection (no platform label).
 */
export function detectSocial(s: SocialSignals): DetectionResult {
  // Platform-specific detection
  for (const detector of PLATFORM_DETECTORS) {
    if (detector.match(s)) {
      return {
        detected: true,
        platform: detector.key,
        tagNames: [SOCIAL_MAIN_TAG, detector.tagName],
        score: 10,
      };
    }
  }

  // Aggressive generic scoring
  let score = 0;

  const ratio = s.aspectRatio ?? (s.width && s.height ? s.width / s.height : undefined);
  if (ratio !== undefined && ratio >= 0.50 && ratio <= 0.58) score += 2;

  if (!s.hasCameraMake && !s.hasCameraModel) score += 2;

  if (!s.hasGps) score += 1;

  const encoderVal = s.containerTags['encoder'] ?? '';
  if (/lavf|lavc/i.test(encoderVal)) score += 1;

  if (!s.hasContainerCreationTime) score += 1;

  const baseName = s.filename.replace(/\.[^.]+$/, '');
  const hasNoPrefix = !/^(img_|dsc|pxl_|vid_|mvimg_|photo_|screenshot)/i.test(baseName);
  const isNumericOrUuid = /^[\d\-_a-f]{8,}$/i.test(baseName);
  if (hasNoPrefix && isNumericOrUuid) score += 1;

  if (s.codec === 'h264' && (s.width ?? 9999) <= 1080) score += 0.5;

  if (score >= 3) {
    return {
      detected: true,
      platform: null,
      tagNames: [SOCIAL_MAIN_TAG],
      score,
    };
  }

  return { detected: false, platform: null, tagNames: [], score };
}
