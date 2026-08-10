// =============================================================================
// Settings Type Definitions
// =============================================================================

import { encryptSecret } from '../crypto/secret-cipher';

/**
 * One table's persisted DataTable layout (issue #255).
 *
 * EVERY field is optional and is NEVER filled in server-side. An absent field
 * means "fall back to the column contract's priority-derived default", so a
 * newly added column appears for users who already persisted a layout instead
 * of being silently hidden. See docs/specs/datatable.md §14.
 */
export interface DataTableLayoutValue {
  visibleColumns?: string[];
  density?: 'compact' | 'standard' | 'comfortable';
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  pageSize?: number;
}

/**
 * Per-user notification preferences (issue #251, epic #240).
 *
 * EVERY field is optional and is NEVER filled in server-side. An absent key
 * means ENABLED — which is what lets this namespace ship with no migration
 * (existing users keep receiving everything) and makes a newly added
 * NotificationType opt-OUT rather than opt-in. Same absent-key contract as
 * `dataTables` above; see the schema for the "do not add .default()" warning.
 *
 * The one deliberate exception is `workflowMicroRuns`, whose ABSENT default is
 * FALSE — `on_media_enriched` workflow micro-runs are suppressed unless a user
 * explicitly opts in, because they fire continuously during an import. That
 * inversion lives in resolveNotificationPreferences(), not in the schema.
 */
export interface NotificationPreferencesValue {
  /** Master switch. Absent = true. */
  enabled?: boolean;
  /** Per-`NotificationType` switch, keyed by the enum value. Absent = true. */
  types?: Record<string, boolean>;
  /** Re-enable `on_media_enriched` workflow-run rows. Absent = FALSE. */
  workflowMicroRuns?: boolean;
}

/** One inclusive `YYYY-MM-DD` date window a user never wants resurfaced. */
export interface MemoriesHiddenDateRangeValue {
  from: string;
  to: string;
}

/**
 * Per-user Memories preferences (epic #300, issue #307).
 *
 * EVERY field is optional and is NEVER filled in server-side. An absent key
 * means "no preference" — no person is hidden, no date range is sensitive, and
 * the digest is NOT opted out of. Same absent-key contract as `dataTables` and
 * `notifications` above, and the same reason it needs no data migration: every
 * existing row simply has no namespace.
 *
 * `hiddenPersonIds` / `hiddenDateRanges` filter READ paths only (see
 * MemoriesService) — generation is circle-scoped and cannot be personalised.
 */
export interface MemoriesPreferencesValue {
  /** Memories whose `personId` is listed are dropped from list + feed. */
  hiddenPersonIds?: string[];
  /** Memories whose `[periodStart, periodEnd]` overlaps a range are dropped. */
  hiddenDateRanges?: MemoriesHiddenDateRangeValue[];
  /** Absent = false, i.e. the user receives the circle's memory digest. */
  emailDigestOptOut?: boolean;
}

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    /**
     * @deprecated (issue #354) No-op. Avatar selection moved to the user row —
     * `User.avatarSource` / `avatarStorageKey` / `linkedPersonId`, written only
     * by UserAvatarService and resolved into `User.profileImageUrl`. Nothing in
     * the API reads this key; it is retained so stored settings blobs and older
     * clients keep validating.
     */
    useProviderImage: boolean;
    /** @deprecated (issue #354) No-op — see useProviderImage above. */
    customImageUrl?: string | null;
  };
  search?: {
    visibleFields: string[];
  };
  /**
   * Per-table DataTable layout, keyed by stable table id. Absent for any user
   * who has never persisted a layout — which is the normal state, and why this
   * namespace needed no data migration.
   */
  dataTables?: Record<string, DataTableLayoutValue>;
  /**
   * Per-type notification preferences. Absent for any user who has never
   * changed a notification toggle — which is the normal state, and why this
   * namespace needed no data migration. Absent ⇒ everything enabled.
   */
  notifications?: NotificationPreferencesValue;
  /**
   * Per-user Memories preferences (issue #307). Absent for any user who has
   * never hidden a person or a date range — the normal state, and why this
   * namespace needed no data migration. Absent ⇒ nothing filtered.
   */
  memories?: MemoriesPreferencesValue;
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
   *   - faceAutoArchive: auto-archive faces matching a previously-archived face
   *   - pictureEnhancement: AI picture enhancer
   *   - workflows: media workflow automation
   *   - memories: curated memory collections (On This Day, Trips, People, …)
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
      /** Active provider+model for AI picture enhancement; null when unset. */
      enhance?: {
        provider: string;
        model: string;
      } | null;
      /**
       * Active chat-capable provider+model for Memories title/subtitle/narrative
       * generation (epic #300); null when unset, in which case memory titles fall
       * back to deterministic templates. Consumed by MemoryTitleService (#306).
       */
      memories?: {
        provider: string;
        model: string;
      } | null;
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
    autoArchive?: {
      /** Cosine-similarity threshold for auto-archiving a face that matches a previously-archived face. */
      matchThreshold: number;
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
    /** Confidence percentage (0–100) at/above which a pending burst group is eligible for bulk auto-resolve. */
    autoResolveThreshold: number;
  };
  dedup?: {
    similarityThreshold: number;
    hashMaxDistance: number;
    knnCandidates: number;
    /** Confidence percentage (0–100) at/above which a pending duplicate group is eligible for bulk auto-resolve. */
    autoResolveThreshold: number;
  };
  locationInference?: {
    maxGapMinutes: number;
    maxExtrapolationGapMinutes: number;
    autoApplyMaxGapMinutes: number;
    requireSameDevice: boolean;
    maxAnchorDistanceKm: number;
    maxImpliedSpeedKmh: number;
    bulkAcceptThreshold: number;
  };
  socialMedia?: {
    ocrEnabled: boolean;
    ocrLanguages: string[];
    ocrMaxFrames: number;
    ocrTimeoutSeconds: number;
    minConfidence: number;
    /** Videos longer than this are treated as clean without download/OCR. */
    maxDurationSeconds: number;
    /** Size fallback (bytes) used only when the duration is unknown. */
    maxSizeBytes: number;
  };
  geo?: {
    reverseProvider: 'offline' | 'nominatim' | 'google';
    forwardSearchEnabled: boolean;
  };
  /**
   * Transactional email configuration.
   * `smtpPassword` holds AES-256-GCM ENCRYPTED ciphertext (never plaintext) and
   * is stripped from the generic system-settings HTTP response.
   */
  email?: {
    provider: 'ses' | 'smtp' | null;
    enabled: boolean;
    sesRegion: string | null;
    smtpHost: string | null;
    smtpPort: number;
    smtpUseTls: boolean;
    smtpUsername: string | null;
    /** AES-256-GCM ciphertext of the SMTP password, or null. */
    smtpPassword: string | null;
    fromAddress: string | null;
    fromName: string | null;
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
  /**
   * Review-queue run history retention (issue #190). Governs the nightly
   * `review_run_history_purge` sweep over BOTH `review_runs` and
   * `trash_empty_runs` — neither table had a purge before this setting existed.
   */
  reviewRuns?: {
    /** Days a terminal review/trash-empty run is kept before deletion. */
    runHistoryRetentionDays: number;
  };
  /**
   * Notification Center retention (epic #240, issue #248). Governs the nightly
   * `notification_purge` sweep over the `notifications` table.
   */
  notifications?: {
    /**
     * Days a RESOLVED notification is kept before deletion, measured from
     * `dismissed_at` / `read_at`. Unread rows are never deleted by age — see
     * NotificationPurgeHandler for why that asymmetry with jobs.history is
     * deliberate.
     */
    retentionDays: number;
    /** Forensic escape hatch: when false the nightly cron never enqueues. */
    purgeEnabled: boolean;
  };
  pictureEnhancement?: {
    defaultQuality: 'low' | 'medium' | 'high';
    defaultStrength: 'subtle' | 'balanced' | 'strong';
    /**
     * Whether to carry the original's EXIF/GPS/IPTC/XMP/ICC onto the enhanced
     * file and stamp the AI marker (ExifCarryoverService). Default true.
     */
    stampExif: boolean;
    /** If false, only "keep both" is offered — originals are never overwritten. */
    allowReplace: boolean;
    /** If true, disable "replace" when enhanced dims < original. */
    blockReplaceOnDownscale: boolean;
    /** Skip/guard absurdly large inputs. */
    maxInputMegapixels: number;
    /**
     * How long unapplied staging previews live before the purge cron reaps them.
     * Defaults to 168h (7 days) — the enhancements hub is an inbox users work
     * through over time, so a shorter window silently destroys unreviewed work.
     */
    retentionHours: number;
  };
  /**
   * Node backup change feed (issue #310, epic #308). Read by
   * NodeBackupQueryService via the cached SystemSettingsService.getSettings().
   */
  backup?: {
    /** Max rows a node may request per change-feed / manifest page. */
    maxPageSize: number;
    /**
     * Rows with `updatedAt` within the last N seconds are withheld from the
     * feed so in-flight same-timestamp writes cannot be skipped by the keyset
     * cursor. 0 disables the horizon.
     */
    feedSafetyHorizonSeconds: number;
    /** Minutes without an ack before a `running` backup run is marked stale. */
    runStaleMinutes: number;
  };
  /**
   * Media Workflow Automation (epic #138). Full namespace ships in Phase 1 so all
   * later phases read through getSettings() with no further schema change. Phase 1
   * actively reads maxItemsPerRun / maxWorkflowsPerCircle / requirePreview /
   * previewTtlHours; the rest are consumed by Phases 2/4.
   */
  workflows?: {
    /** Hard cap on media items materialized/evaluated per run. */
    maxItemsPerRun: number;
    /** Items per queue-backed execution batch (Phase 2). */
    batchSize: number;
    /** Simultaneous non-terminal runs allowed (Phase 2/4). */
    maxConcurrentRuns: number;
    /** When true, manual runs default to preview + approval (Phase 2). */
    requirePreview: boolean;
    /** When false, hard-delete actions are never permitted (Phase 2). */
    allowHardDelete: boolean;
    /** Max stored workflow definitions per circle. */
    maxWorkflowsPerCircle: number;
    /** How long a stateless preview result is considered fresh (Phase 3). */
    previewTtlHours: number;
    /** Run/item history retention before the purge sweep (Phase 5). */
    runHistoryRetentionDays: number;
    /** Per-trigger master switches (Phase 4). */
    triggers: {
      onEnrichment: boolean;
      scheduled: boolean;
    };
    /** Minimum cron interval enforced for scheduled workflows (Phase 4). */
    scheduleMinIntervalMinutes: number;
  };
  /**
   * Memories (epic #300). The full namespace ships with the generation job
   * skeleton (issue #302) so later issues read it through getSettings() with no
   * further schema change. Issue #302 actively reads only
   * `generation.intervalHours` (plus the `features.memories` flag).
   */
  memories?: MemoriesSettingsValue;
  /**
   * PostgreSQL Database Backup & Restore (epic #339, issue #340). The full
   * namespace ships here as a schema-only foundation so every later issue in
   * the epic reads its parameters through the one cached getSettings() call
   * with no further schema change.
   */
  databaseBackup?: DatabaseBackupSettingsValue;
  /**
   * Admin-controlled maintenance mode (issue #348). Persisted so the flag
   * survives the container restart it was enabled for; MaintenanceModeService
   * layers a process-local override on top for the #344 DB-rename window.
   */
  maintenance?: MaintenanceSettingsValue;
}

/** The `maintenance.*` system-settings namespace (issue #348). */
export interface MaintenanceSettingsValue {
  /** Persisted master switch. The env override wins over this in both directions. */
  enabled: boolean;
  /** Operator message shown on the maintenance screen (≤500 chars). */
  message: string;
  /** When true (default), Admin-role users bypass the 503 entirely. */
  allowAdmins: boolean;
  /** ISO timestamp maintenance was last enabled; null when off. */
  startedAt: string | null;
  /** User id that enabled maintenance; null when off. */
  startedById: string | null;
}

/** The `databaseBackup.*` system-settings namespace (epic #339, issue #340). */
export interface DatabaseBackupSettingsValue {
  /** Master switch for the scheduled backup cron. */
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  /** Day of week (0=Sunday) the weekly schedule fires on. */
  dayOfWeek: number;
  /** Day of month (1-28) the monthly schedule fires on. */
  dayOfMonth: number;
  /** "HH:mm" local time (in `timezone`) the schedule fires at. */
  timeOfDay: string;
  /** IANA timezone name the schedule is evaluated in. */
  timezone: string;
  /** How many completed backups to retain before pruning the oldest. */
  retentionCount: number;
  /** Storage provider key backups are written to; null = use the active storage provider. */
  storageProvider: string | null;
  /** Minutes without a heartbeat before a `running` backup run is marked stale. */
  runStaleMinutes: number;
  /** pg_dump custom-format compression level, 0 (none) to 9 (max). */
  compressionLevel: number;
  /** How the old database is handled after a restore swap. */
  restoreRollbackMode: 'retain_database' | 'pre_restore_dump';
  /** Hours the pre-swap old database is retained before cleanup. */
  oldDatabaseRetentionHours: number;
}

/** The `memories.*` system-settings namespace (epic #300, issue #302). */
export interface MemoriesSettingsValue {
  generation: {
    /** Hours between scheduled per-circle `memory_generation` jobs. */
    intervalHours: number;
  };
  /** Hard cap on `MemoryItem` rows a curator may attach to one memory. */
  maxItemsPerMemory: number;
  /** Master switch for AI-written titles; templates are used when off (#306). */
  aiTitles: { enabled: boolean };
  onThisDay: { enabled: boolean; lookbackYears: number; minItems: number };
  trips: {
    enabled: boolean;
    minDays: number;
    minItems: number;
    minDistanceKm: number;
    lookbackMonths: number;
  };
  people: { enabled: boolean; favoritesOnly: boolean; minItems: number };
  themes: { enabled: boolean; minItems: number; maxPerPeriod: number };
  seasonal: { enabled: boolean; minItems: number };
  yearInReview: { enabled: boolean; minItems: number };
  digest: {
    enabled: boolean;
    frequency: 'off' | 'daily' | 'weekly' | 'monthly';
    sendHourUtc: number;
    imageTokenTtlDays: number;
  };
}

/**
 * Resolve whether the Media Workflow Automation feature is active: the
 * `features.workflows` system-setting toggle must be on AND the
 * `WORKFLOWS_ENABLED` env kill-switch must not be explicitly set to 'false'.
 */
export function isWorkflowsEnabled(settings: {
  features?: Record<string, boolean>;
}): boolean {
  return (
    settings.features?.[FEATURE_KEYS.WORKFLOWS] === true &&
    process.env['WORKFLOWS_ENABLED'] !== 'false'
  );
}

/**
 * Resolve whether the AI Picture Enhancer feature is active: the
 * `features.pictureEnhancement` system-setting toggle must be on AND the
 * `PICTURE_ENHANCEMENT_ENABLED` env kill-switch must not be explicitly set to
 * 'false'.
 *
 * Single source of truth shared by the server-side gate
 * (MediaEnhancementService.startEnhance / getAdminStatus) and the client-visible
 * gate (GET /api/features), so the UI never offers an action the API rejects.
 */
export function isPictureEnhancementEnabled(settings: {
  features?: Record<string, boolean>;
}): boolean {
  return (
    settings.features?.[FEATURE_KEYS.PICTURE_ENHANCEMENT] === true &&
    process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false'
  );
}

/**
 * Resolve whether the Memories feature is active: the `features.memories`
 * system-setting toggle must be on AND the `MEMORIES_ENABLED` env kill-switch
 * must not be explicitly set to 'false'.
 *
 * Single source of truth shared by the generation cron, the generation handler,
 * and every later Memories surface in epic #300, so no caller can drift from
 * the others on what "enabled" means. Mirrors isWorkflowsEnabled /
 * isPictureEnhancementEnabled above.
 */
export function isMemoriesEnabled(settings: {
  features?: Record<string, boolean>;
}): boolean {
  return (
    settings.features?.[FEATURE_KEYS.MEMORIES] === true &&
    process.env['MEMORIES_ENABLED'] !== 'false'
  );
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
 * Build the default `email.*` settings block from environment variables.
 * `SMTP_PASSWORD`, if present, is encrypted at rest before being stored.
 */
export function defaultEmailSettings(): NonNullable<SystemSettingsValue['email']> {
  const envProvider = process.env['EMAIL_PROVIDER'];
  const provider: 'ses' | 'smtp' | null =
    envProvider === 'ses' || envProvider === 'smtp' ? envProvider : null;

  const smtpPortRaw = process.env['SMTP_PORT'];
  const smtpPort = smtpPortRaw && !isNaN(parseInt(smtpPortRaw, 10))
    ? parseInt(smtpPortRaw, 10)
    : 587;

  const smtpUseTlsRaw = process.env['SMTP_USE_TLS'];

  return {
    provider,
    enabled: false,
    sesRegion: process.env['AWS_SES_REGION'] ?? null,
    smtpHost: process.env['SMTP_HOST'] ?? null,
    smtpPort,
    smtpUseTls: smtpUseTlsRaw ? smtpUseTlsRaw !== 'false' : true,
    smtpUsername: process.env['SMTP_USERNAME'] ?? null,
    smtpPassword: process.env['SMTP_PASSWORD']
      ? encryptSecret(process.env['SMTP_PASSWORD'])
      : null,
    fromAddress: process.env['EMAIL_FROM_ADDRESS'] ?? null,
    fromName: process.env['EMAIL_FROM_NAME'] ?? null,
  };
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
  FACE_AUTO_ARCHIVE: 'faceAutoArchive',
  PICTURE_ENHANCEMENT: 'pictureEnhancement',
  WORKFLOWS: 'workflows',
  MEMORIES: 'memories',
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
    [FEATURE_KEYS.FACE_AUTO_ARCHIVE]: false,
    [FEATURE_KEYS.PICTURE_ENHANCEMENT]: false,
    [FEATURE_KEYS.WORKFLOWS]: false,
    [FEATURE_KEYS.MEMORIES]: false,
  },
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
      enhance: null,
      memories: null,
    },
  },
  face: {
    features: {
      detection: { provider: null, model: null },
    },
    video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    autoArchive: { matchThreshold: 0.45 },
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
    autoResolveThreshold: 60,
  },
  dedup: {
    similarityThreshold: 0.96,
    hashMaxDistance: 6,
    knnCandidates: 20,
    autoResolveThreshold: 60,
  },
  locationInference: {
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
    bulkAcceptThreshold: 80,
  },
  socialMedia: {
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
    maxDurationSeconds: 300,
    maxSizeBytes: 500_000_000,
  },
  geo: {
    reverseProvider: process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline',
    forwardSearchEnabled: process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true',
  },
  email: defaultEmailSettings(),
  jobs: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: defaultStuckThresholdMinutes(),
  },
  reviewRuns: {
    runHistoryRetentionDays: 30,
  },
  notifications: {
    retentionDays: 30,
    purgeEnabled: true,
  },
  pictureEnhancement: {
    defaultQuality: 'high',
    defaultStrength: 'balanced',
    stampExif: true,
    allowReplace: true,
    blockReplaceOnDownscale: false,
    maxInputMegapixels: 50,
    retentionHours: 168,
  },
  backup: {
    maxPageSize: 200,
    feedSafetyHorizonSeconds: 5,
    runStaleMinutes: 15,
  },
  workflows: {
    maxItemsPerRun: 10000,
    batchSize: 200,
    maxConcurrentRuns: 2,
    requirePreview: true,
    allowHardDelete: false,
    maxWorkflowsPerCircle: 20,
    previewTtlHours: 24,
    runHistoryRetentionDays: 30,
    triggers: {
      onEnrichment: true,
      scheduled: true,
    },
    scheduleMinIntervalMinutes: 60,
  },
  memories: {
    generation: { intervalHours: 24 },
    maxItemsPerMemory: 30,
    aiTitles: { enabled: true },
    onThisDay: { enabled: true, lookbackYears: 10, minItems: 3 },
    trips: { enabled: true, minDays: 2, minItems: 10, minDistanceKm: 50, lookbackMonths: 18 },
    people: { enabled: true, favoritesOnly: true, minItems: 8 },
    themes: { enabled: true, minItems: 8, maxPerPeriod: 3 },
    seasonal: { enabled: true, minItems: 12 },
    yearInReview: { enabled: true, minItems: 15 },
    digest: { enabled: true, frequency: 'weekly', sendHourUtc: 8, imageTokenTtlDays: 30 },
  },
  databaseBackup: {
    enabled: false,
    frequency: 'daily',
    dayOfWeek: 0,
    dayOfMonth: 1,
    timeOfDay: '02:00',
    timezone: 'UTC',
    retentionCount: 7,
    storageProvider: null,
    runStaleMinutes: 30,
    compressionLevel: 1,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 168,
  },
  maintenance: {
    enabled: false,
    message: '',
    allowAdmins: true,
    startedAt: null,
    startedById: null,
  },
};
