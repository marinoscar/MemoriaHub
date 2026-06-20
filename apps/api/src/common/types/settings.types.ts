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
}

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
  features: {},
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
    },
  },
  face: {
    features: {
      detection: { provider: null, model: null },
    },
  },
};
