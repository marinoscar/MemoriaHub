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
  };
  storage?: {
    activeProvider?: string;
    insights: {
      refreshIntervalHours: number;
    };
  };
  burst?: {
    timeGapSeconds: number;
    hashDistance: number;
    minGroupSize: number;
  };
  geo?: {
    provider: 'offline' | 'nominatim';
    forwardSearchEnabled: boolean;
  };
}

/**
 * Constants for the well-known feature flag keys stored in SystemSettingsValue.features.
 */
export const FEATURE_KEYS = {
  AUTO_TAGGING: 'autoTagging',
  FACE_RECOGNITION: 'faceRecognition',
  BURST_DETECTION: 'burstDetection',
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
  },
  storage: {
    activeProvider: process.env['STORAGE_PROVIDER'] ?? 's3',
    insights: {
      refreshIntervalHours: 4,
    },
  },
  burst: {
    timeGapSeconds: 10,
    hashDistance: 10,
    minGroupSize: 3,
  },
  geo: {
    provider: process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline',
    forwardSearchEnabled: process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true',
  },
};
