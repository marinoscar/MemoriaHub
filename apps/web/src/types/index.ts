export interface Role {
  name: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  profileImageUrl: string | null;
  roles: Role[];
  permissions: string[];
  isActive: boolean;
  createdAt: string;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  search?: {
    visibleFields: string[];
  };
  activeCircleId?: string | null;
  updatedAt: string;
  version: number;
}

export interface SystemSettings {
  ui: {
    allowUserThemeOverride: boolean;
  };
  features: Record<string, boolean>;
  storage?: {
    insights?: {
      refreshIntervalHours?: number;
    };
    activeProvider?: string;
    trash?: {
      retentionDays?: number;
    };
  };
  jobs?: {
    history?: {
      retentionDays?: number;
      purgeEnabled?: boolean;
    };
    stuckThresholdMinutes?: number;
  };
  burst?: {
    timeGapSeconds?: number;
    hashDistance?: number;
    minGroupSize?: number;
    autoResolveThreshold?: number;
  };
  dedup?: {
    similarityThreshold?: number;
    hashMaxDistance?: number;
    knnCandidates?: number;
    autoResolveThreshold?: number;
  };
  locationInference?: {
    maxGapMinutes?: number;
    maxExtrapolationGapMinutes?: number;
    autoApplyMaxGapMinutes?: number;
    requireSameDevice?: boolean;
    maxAnchorDistanceKm?: number;
    maxImpliedSpeedKmh?: number;
  };
  geo?: {
    reverseProvider?: 'offline' | 'nominatim' | 'google';
    forwardSearchEnabled?: boolean;
  };
  face?: {
    video?: {
      enabled?: boolean;
      sampleIntervalSeconds?: number;
      maxFramesPerVideo?: number;
    };
    autoArchive?: {
      matchThreshold?: number;
    };
  };
  socialMedia?: {
    ocrEnabled?: boolean;
    ocrLanguages?: string[];
    ocrMaxFrames?: number;
    ocrTimeoutSeconds?: number;
    minConfidence?: number;
    /** Videos longer than this are treated as clean without download/OCR. */
    maxDurationSeconds?: number;
    /** Size fallback (bytes) used only when the duration is unknown. */
    maxSizeBytes?: number;
  };
  workflows?: {
    maxItemsPerRun?: number;
    batchSize?: number;
    maxConcurrentRuns?: number;
    requirePreview?: boolean;
    allowHardDelete?: boolean;
    maxWorkflowsPerCircle?: number;
    previewTtlHours?: number;
    runHistoryRetentionDays?: number;
    triggers?: {
      onEnrichment?: boolean;
      scheduled?: boolean;
    };
    scheduleMinIntervalMinutes?: number;
  };
  updatedAt: string;
  updatedBy: { id: string; email: string } | null;
  version: number;
}

export interface AuthProvider {
  name: string;
  authUrl: string;
}

export interface AllowedEmailEntry {
  id: string;
  email: string;
  addedBy: { id: string; email: string } | null;
  addedAt: string;
  claimedBy: { id: string; email: string } | null;
  claimedAt: string | null;
  notes: string | null;
}

export interface AllowlistResponse {
  items: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserListItem {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl?: string | null;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UsersResponse {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface DeviceActivationInfo {
  userCode: string;
  clientInfo: {
    deviceName?: string;
    userAgent?: string;
    ipAddress?: string;
    /** Deep-link URI the device wants the browser to call after approval (e.g. memoriahub://auth/device-complete). */
    returnUri?: string;
  };
  expiresAt: string;
}

export interface DeviceAuthorizationResponse {
  success: boolean;
  message: string;
}

// Personal Access Tokens
export type PatDurationUnit = 'minutes' | 'days' | 'months';

export interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  durationValue: number;
  durationUnit: PatDurationUnit;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PatCreatedResponse {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string;
  createdAt: string;
}
