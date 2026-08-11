import type { DataTableStoredLayout } from '../components/datatable/layout/layoutModel';
import type {
  NotificationPreferences,
  NotificationPreferencesPatch,
} from './notifications';
import type {
  MemoriesPreferences,
  MemoriesPreferencesPatch,
} from './memories';

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

/**
 * The `user_settings.navigation` namespace as it travels on the wire.
 *
 * Mirrors the API's `navigationPreferencesSchema`. Both fields are optional
 * with no default, which is what lets the namespace ship without a migration.
 */
export interface NavigationPreferences {
  /** Ordered pin list, ≤ 6 entries. See the note on `UserSettings.navigation`. */
  pinned?: string[];
  /** Desktop rail collapse preference. Absent ⇒ expanded. */
  railCollapsed?: boolean;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  /**
   * @deprecated Superseded by `GET`/`PATCH /api/users/me/profile` and the
   * `/profile` page (issue #354). The API still returns this namespace, but
   * `useProviderImage` and `customImageUrl` are inert: the avatar's source is
   * first-class user state (`avatarSource`) now, not a settings blob. Nothing
   * in the web app writes these keys — do not reintroduce a UI that does.
   */
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  search?: {
    visibleFields: string[];
  };
  /**
   * Per-user, per-table DataTable layout (issue #255) — column visibility,
   * density, sort and page size, keyed by the table's `tableId`.
   *
   * Every key is optional and the API never materializes one: an absent entry,
   * or an absent field inside an entry, means "use the column contract's
   * defaults". See docs/specs/datatable.md §14–§15.
   */
  dataTables?: Record<string, DataTableStoredLayout>;
  /**
   * Per-type notification preferences (issue #251).
   *
   * Same absent-key contract as `dataTables`: the API returns this namespace
   * verbatim and never materializes it, so `undefined` here is the normal
   * state for a user who has never opened the Notifications section — and it
   * means EVERYTHING IS ENABLED, not "nothing configured yet".
   */
  notifications?: NotificationPreferences;
  /**
   * Per-user Memories preferences (issue #307's namespace, issue #313's UI):
   * hidden people, sensitive date ranges, email-digest opt-out.
   *
   * Same absent-key contract again — `undefined` is the normal state and means
   * "no preference", NOT "nothing configured yet".
   */
  memories?: MemoriesPreferences;
  /**
   * Per-user navigation preferences (issue #392, epic #388, spec §5): the
   * desktop rail's pin list and its collapse state.
   *
   * Same absent-key contract as the three namespaces above — `undefined` is the
   * normal state and means "nothing pinned, rail expanded", NOT "not configured
   * yet". Nothing writes a default back.
   *
   * `pinned` is typed as `string[]` rather than the narrower `PinnableKey[]` ON
   * PURPOSE: this is the WIRE shape, and a blob written by an older release may
   * legitimately contain a key this build no longer knows. Unknown keys are
   * dropped on read by `useNavigationPrefs`' `sanitizePinned`; typing them out
   * of existence here would only push that lie into the compiler.
   */
  navigation?: NavigationPreferences;
  activeCircleId?: string | null;
  updatedAt: string;
  version: number;
}

/**
 * What may be sent to `PATCH /api/user-settings`.
 *
 * `Partial<UserSettings>` almost describes it, but the `notifications` and
 * `memories` namespaces accept a strictly wider value on the way IN than they
 * ever hold at rest: a key may be `null` to delete the override (JSON Merge
 * Patch). Modelling that here keeps the delete expressible without a cast at
 * the call site.
 */
export type UserSettingsUpdate = Partial<
  Omit<UserSettings, 'notifications' | 'memories'>
> & {
  notifications?: NotificationPreferencesPatch | null;
  memories?: MemoriesPreferencesPatch | null;
};

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
  /**
   * Notification Center retention (issue #248). `retentionDays` ages out only
   * notifications the user has already read or dismissed — unread rows are
   * never deleted by age.
   */
  notifications?: {
    retentionDays?: number;
    purgeEnabled?: boolean;
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
    bulkAcceptThreshold?: number;
  };
  /**
   * Location Grouping (epic #373). `features.locationGrouping` is the master
   * toggle; these are the tuning knobs. `maxRadiusKm` is the ceiling the API
   * validates a group's `radiusKm` against, so the admin UI's radius slider
   * binds its max to this value rather than a hard-coded constant.
   */
  locationGrouping?: {
    radiusCaptureEnabled?: boolean;
    maxRadiusKm?: number;
    suggestionMinItems?: number;
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
  pictureEnhancement?: {
    defaultQuality?: 'low' | 'medium' | 'high';
    defaultStrength?: 'subtle' | 'balanced' | 'strong';
    stampExif?: boolean;
    allowReplace?: boolean;
    blockReplaceOnDownscale?: boolean;
    maxInputMegapixels?: number;
    retentionHours?: number;
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
  /**
   * Memories (epic #300). Mirrors the `memories` namespace in
   * `apps/api/src/common/schemas/settings.schema.ts` — every bound quoted in
   * `/admin/settings/memories`'s number fields comes from there.
   *
   * Every key is optional because the namespace is genuinely absent on any
   * deployment that has never saved it; the admin page reads each value with a
   * `?? default` fallback rather than assuming presence.
   */
  memories?: {
    generation?: { intervalHours?: number };
    maxItemsPerMemory?: number;
    aiTitles?: { enabled?: boolean };
    onThisDay?: { enabled?: boolean; lookbackYears?: number; minItems?: number };
    trips?: {
      enabled?: boolean;
      minDays?: number;
      minItems?: number;
      minDistanceKm?: number;
      lookbackMonths?: number;
    };
    people?: { enabled?: boolean; favoritesOnly?: boolean; minItems?: number };
    themes?: { enabled?: boolean; minItems?: number; maxPerPeriod?: number };
    seasonal?: { enabled?: boolean; minItems?: number };
    yearInReview?: { enabled?: boolean; minItems?: number };
    digest?: {
      enabled?: boolean;
      frequency?: 'off' | 'daily' | 'weekly' | 'monthly';
      sendHourUtc?: number;
      imageTokenTtlDays?: number;
    };
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
