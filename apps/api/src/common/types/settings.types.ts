// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  search?: {
    visibleFields: string[];
  };
}

/**
 * System settings schema - stored in system_settings.value JSONB
 */
export interface SystemSettingsValue {
  ui: {
    allowUserThemeOverride: boolean;
  };
  /**
   * Well-known global feature flag keys (system-wide on/off, Admin-managed):
   *   - autoTagging: AI auto-tagging + description generation
   *   - faceRecognition: face detection / recognition
   *   - burstDetection: burst photo (similar pictures) detection
   *   - duplicateDetection: near-duplicate photo (visual/hash similarity) detection
   *   - locationInference: interpolate/extrapolate missing GPS coords from timeline anchors
   *   - socialMediaDetection: social-media video detection (OCR-based)
   */
  features: {
    [key: string]: boolean;
  };
  ai: {
    features: {
      search: {
        provider: string | null;
        model: string | null;
      };
      tagging: {
        provider: string | null;
        model: string | null;
      };
      embedding: {
        provider: string | null;
        model: string | null;
      };
    };
  };
  face?: {
    features: {
      detection: {
        provider: string | null;
        model: string | null;
      };
    };
    video?: {
      enabled: boolean;
      sampleIntervalSeconds: number;
      maxFramesPerVideo: number;
    };
  };
  storage?: {
    activeProvider?: string;
    insights: {
      refreshIntervalHours: number;
    };
    trash: {
      retentionDays: number;
    };
  };
  burst?: {
    timeGapSeconds: number;
    hashDistance: number;
    minGroupSize: number;
  };
  dedup?: {
    similarityThreshold: number;
    hashMaxDistance: number;
    knnCandidates: number;
  };
  locationInference?: {
    maxGapMinutes: number;
    maxExtrapolationGapMinutes: number;
    autoApplyMaxGapMinutes: number;
    requireSameDevice: boolean;
    maxAnchorDistanceKm: number;
    maxImpliedSpeedKmh: number;
  };
  socialMedia?: {
    ocrEnabled: boolean;
    ocrLanguages: string[];
    ocrMaxFrames: number;
    ocrTimeoutSeconds: number;
    minConfidence: number;
  };
  geo?: {
    reverseProvider: 'offline' | 'nominatim' | 'google';
    forwardSearchEnabled: boolean;
  };
  jobs?: {
    history: {
      retentionDays: number;
      purgeEnabled: boolean;
    };
    /**
     * Minutes a `running` enrichment job may go without finishing before the
     * stats endpoint counts it as stuck and the reset cron re-queues it.
     */
    stuckThresholdMinutes?: number;
  };
}

/**
 * Default for jobs.stuckThresholdMinutes: the legacy ENRICHMENT_STUCK_MINUTES
 * env var when set to a valid positive integer (clamped to the 1–120 setting
 * bounds), else 3 minutes.
 */
export function defaultStuckThresholdMinutes(): number {
  const raw = process.env['ENRICHMENT_STUCK_MINUTES'];
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return Math.min(parsed, 120);
  }
  return 3;
}

/**
 * Constants for the well-known feature flag keys stored in SystemSettingsValue.features.
 */
export const FEATURE_KEYS = {
  AUTO_TAGGING: 'autoTagging',
  FACE_RECOGNITION: 'faceRecognition',
  BURST_DETECTION: 'burstDetection',
  DUPLICATE_DETECTION: 'duplicateDetection',
  LOCATION_INFERENCE: 'locationInference',
  SOCIAL_MEDIA_DETECTION: 'socialMediaDetection',
} as const;

/**
 * Default user settings
 */
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    useProviderImage: true,
  },
  search: {
    visibleFields: [],
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {
    [FEATURE_KEYS.AUTO_TAGGING]: false,
    [FEATURE_KEYS.FACE_RECOGNITION]: false,
    [FEATURE_KEYS.BURST_DETECTION]: false,
    [FEATURE_KEYS.DUPLICATE_DETECTION]: false,
    [FEATURE_KEYS.LOCATION_INFERENCE]: false,
    [FEATURE_KEYS.SOCIAL_MEDIA_DETECTION]: false,
  },
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
    },
  },
  face: {
    features: {
      detection: { provider: null, model: null },
    },
    video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
  },
  storage: {
    activeProvider: process.env['STORAGE_PROVIDER'] ?? 's3',
    insights: {
      refreshIntervalHours: 4,
    },
    trash: {
      retentionDays: 30,
    },
  },
  burst: {
    timeGapSeconds: 10,
    hashDistance: 10,
    minGroupSize: 3,
  },
  dedup: {
    similarityThreshold: 0.96,
    hashMaxDistance: 6,
    knnCandidates: 20,
  },
  locationInference: {
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
  },
  socialMedia: {
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
  },
  geo: {
    reverseProvider: process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline',
    forwardSearchEnabled: process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true',
  },
  jobs: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: defaultStuckThresholdMinutes(),
  },
};
