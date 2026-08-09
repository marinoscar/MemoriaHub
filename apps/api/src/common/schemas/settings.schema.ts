import { NotificationType } from '@prisma/client';
import { z } from 'zod';

// =============================================================================
// DataTable per-user layout persistence (issue #255, epic #238)
// =============================================================================
//
// Per-user, per-table layout for the shared DataTable component
// (docs/specs/datatable.md §14). Stored inside the existing `user_settings`
// JSONB blob — no new table, no new endpoint, no migration.
//
// This sub-schema is defined ONCE here and imported by the PUT/PATCH/response
// DTOs, deliberately breaking the copy-per-DTO convention used by the rest of
// this file: the bounds below are a security control, and four hand-maintained
// copies of them would drift.
//
// ABSENT-KEY RULE (load-bearing — see the spec):
//   Every field is `.optional()` with NO `.default()`, and `dataTables` itself
//   is optional. An absent key means "fall back to the column contract's
//   priority-derived defaults", NOT "empty". If `visibleColumns` defaulted to
//   `[]` here, a stored entry would pin the table to zero columns and a newly
//   added column would be silently hidden from every user who had ever touched
//   that table's layout. Do not add `.default()` to anything in this block.

/** Max distinct table ids one user may persist layout for. */
export const DATA_TABLE_MAX_TABLES = 40;
/** Max length of a table id key, and of any column id / sort field string. */
export const DATA_TABLE_MAX_ID_LENGTH = 64;
/** Max entries in a `visibleColumns` list. */
export const DATA_TABLE_MAX_VISIBLE_COLUMNS = 60;
/** Inclusive `pageSize` bounds. */
export const DATA_TABLE_MIN_PAGE_SIZE = 1;
export const DATA_TABLE_MAX_PAGE_SIZE = 500;

/** Table ids are lowercase alphanumeric plus `-`/`_`, starting alphanumeric. */
export const DATA_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const dataTableIdentifierSchema = z
  .string()
  .min(1)
  .max(DATA_TABLE_MAX_ID_LENGTH);

const dataTableIdKeySchema = dataTableIdentifierSchema.regex(
  DATA_TABLE_ID_PATTERN,
  'tableId must be lowercase alphanumeric, "-" or "_", starting with a letter or digit',
);

/** One table's persisted layout. `.strict()` — unknown keys are rejected, not stored. */
export const dataTableLayoutSchema = z
  .object({
    visibleColumns: z
      .array(dataTableIdentifierSchema)
      .max(DATA_TABLE_MAX_VISIBLE_COLUMNS)
      .optional(),
    density: z.enum(['compact', 'standard', 'comfortable']).optional(),
    sort: z
      .object({
        field: dataTableIdentifierSchema,
        direction: z.enum(['asc', 'desc']),
      })
      .strict()
      .optional(),
    pageSize: z
      .number()
      .int()
      .min(DATA_TABLE_MIN_PAGE_SIZE)
      .max(DATA_TABLE_MAX_PAGE_SIZE)
      .optional(),
  })
  .strict();

/** The `dataTables` namespace as accepted by PUT and stored at rest. */
export const dataTablesSchema = z
  .record(dataTableIdKeySchema, dataTableLayoutSchema)
  .refine((v) => Object.keys(v).length <= DATA_TABLE_MAX_TABLES, {
    message: `dataTables may hold at most ${DATA_TABLE_MAX_TABLES} table ids`,
  });

/**
 * The `dataTables` namespace as accepted by PATCH. Identical, except a table id
 * may be set to `null` to DELETE that entry (JSON Merge Patch semantics), which
 * is how a client evicts a table it no longer renders without burning a slot
 * against DATA_TABLE_MAX_TABLES.
 */
export const dataTablesPatchSchema = z
  .record(dataTableIdKeySchema, dataTableLayoutSchema.nullable())
  .refine((v) => Object.keys(v).length <= DATA_TABLE_MAX_TABLES, {
    message: `dataTables may hold at most ${DATA_TABLE_MAX_TABLES} table ids`,
  });

export type DataTableLayout = z.infer<typeof dataTableLayoutSchema>;
export type DataTablesSettings = z.infer<typeof dataTablesSchema>;
export type DataTablesPatch = z.infer<typeof dataTablesPatchSchema>;

// =============================================================================
// Per-user notification preferences (issue #251, epic #240)
// =============================================================================
//
// Stored inside the existing `user_settings` JSONB blob — no new table, no new
// endpoint, no migration, no new RBAC permission. Read/written exclusively
// through GET/PATCH/PUT /api/user-settings.
//
// ABSENT-KEY RULE (load-bearing — same contract as `dataTables` above):
//   Every field is `.optional()` with NO `.default()`, and `notifications`
//   itself is optional. An absent key means ENABLED. That is what lets the
//   namespace ship without a data migration (every existing user keeps
//   receiving everything) and makes a newly added NotificationType opt-OUT
//   rather than silently opt-in for anyone who ever saved a preference.
//   Do NOT add `.default()` to anything in this block — a `.default(false)`
//   anywhere here would invert the semantics and mute existing users.
//
// The single deliberate inversion — `workflowMicroRuns` defaulting to FALSE
// when absent — lives in resolveNotificationPreferences() (the notifications
// module), NOT here, precisely so this schema keeps one uniform rule.
//
// WHY z.partialRecord AND NOT z.record. In zod v4, `z.record(z.enum([...]), v)`
// is EXHAUSTIVE: it requires every enum key to be present, so `{ upload_completed:
// false }` would fail validation. `z.partialRecord` is the partial form and
// still rejects unknown keys, which is exactly what is wanted here.

/** Every `NotificationType` value, as a zod enum. */
const notificationTypeKeySchema = z.enum(
  Object.values(NotificationType) as [NotificationType, ...NotificationType[]],
);

/** The `notifications` namespace as accepted by PUT and stored at rest. */
export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    types: z.partialRecord(notificationTypeKeySchema, z.boolean()).optional(),
    workflowMicroRuns: z.boolean().optional(),
  })
  .strict();

/**
 * The `notifications` namespace as accepted by PATCH. Identical, except a
 * per-type entry may be set to `null` to DELETE it (JSON Merge Patch), which
 * resets that type to its default (enabled) rather than pinning it to `true`.
 */
export const notificationPreferencesPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    types: z
      .partialRecord(notificationTypeKeySchema, z.boolean().nullable())
      .optional(),
    workflowMicroRuns: z.boolean().optional(),
  })
  .strict();

export type NotificationPreferencesSettings = z.infer<
  typeof notificationPreferencesSchema
>;
export type NotificationPreferencesPatch = z.infer<
  typeof notificationPreferencesPatchSchema
>;

// =============================================================================
// Per-user Memories preferences (issue #307, epic #300)
// =============================================================================
//
// Stored inside the existing `user_settings` JSONB blob — no new table, no new
// endpoint, no migration, no new RBAC permission. Read/written exclusively
// through GET/PATCH/PUT /api/user-settings, exactly like `dataTables` and
// `notifications` above.
//
// ABSENT-KEY RULE (load-bearing — same contract as the two namespaces above):
//   Every field is `.optional()` with NO `.default()`, and `memories` itself is
//   optional. An absent key means "no preference": nobody is hidden, no date
//   range is sensitive, and the digest is NOT opted out of. That is what lets
//   the namespace ship without a data migration, and it means a future field
//   added here is opt-IN rather than silently applied to everyone who ever
//   saved a preference. Do NOT add `.default()` to anything in this block —
//   a `.default([])` on `hiddenPersonIds` would pin a stored blob to "no
//   people hidden" and make it indistinguishable from "never expressed one".

/** Max hidden person ids one user may persist. */
export const MEMORIES_MAX_HIDDEN_PERSON_IDS = 200;
/** Max sensitive date ranges one user may persist. */
export const MEMORIES_MAX_HIDDEN_DATE_RANGES = 50;

/** Calendar-day key, `YYYY-MM-DD`. */
export const MEMORIES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` string that names a REAL calendar day. The regex alone accepts
 * `2026-02-31`; the round-trip check rejects it, because a range whose bound
 * silently rolls into the next month would filter days the user never named.
 */
const memoriesDateSchema = z
  .string()
  .regex(MEMORIES_DATE_PATTERN, 'Date must be formatted YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, 'Date must be a real calendar day');

/** One inclusive sensitive-date window. `.strict()` — unknown keys rejected. */
export const memoriesHiddenDateRangeSchema = z
  .object({
    from: memoriesDateSchema,
    to: memoriesDateSchema,
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: 'hiddenDateRanges entries require from <= to',
  });

/** The `memories` namespace as accepted by PUT and stored at rest. */
export const memoriesPreferencesSchema = z
  .object({
    hiddenPersonIds: z
      .array(z.string().uuid())
      .max(MEMORIES_MAX_HIDDEN_PERSON_IDS)
      .optional(),
    hiddenDateRanges: z
      .array(memoriesHiddenDateRangeSchema)
      .max(MEMORIES_MAX_HIDDEN_DATE_RANGES)
      .optional(),
    emailDigestOptOut: z.boolean().optional(),
  })
  .strict();

/**
 * The `memories` namespace as accepted by PATCH. Identical, except any field
 * may be set to `null` to DELETE it (JSON Merge Patch), resetting it to its
 * absent default rather than pinning an explicit empty list / `false` that
 * would survive a future default change.
 */
export const memoriesPreferencesPatchSchema = z
  .object({
    hiddenPersonIds: z
      .array(z.string().uuid())
      .max(MEMORIES_MAX_HIDDEN_PERSON_IDS)
      .nullable()
      .optional(),
    hiddenDateRanges: z
      .array(memoriesHiddenDateRangeSchema)
      .max(MEMORIES_MAX_HIDDEN_DATE_RANGES)
      .nullable()
      .optional(),
    emailDigestOptOut: z.boolean().nullable().optional(),
  })
  .strict();

export type MemoriesPreferencesSettings = z.infer<typeof memoriesPreferencesSchema>;
export type MemoriesPreferencesPatch = z.infer<typeof memoriesPreferencesPatchSchema>;

// =============================================================================
// User Settings Schema
// =============================================================================

export const userSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
  search: z.object({
    visibleFields: z.array(z.string()).default([]),
  }).optional(),
  dataTables: dataTablesSchema.optional(),
  notifications: notificationPreferencesSchema.optional(),
  memories: memoriesPreferencesSchema.optional(),
});

export type UserSettingsDto = z.infer<typeof userSettingsSchema>;

// Partial schema for PATCH operations (zod v4: deepPartial removed, use manual deep partial)
export const userSettingsPatchSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean().optional(),
    customImageUrl: z.string().url().nullable().optional(),
  }).optional(),
  search: z.object({
    visibleFields: z.array(z.string()).default([]),
  }).optional(),
  dataTables: dataTablesPatchSchema.optional(),
  // `null` clears the whole namespace back to defaults (everything enabled,
  // micro-runs off) — JSON Merge Patch, mirroring dataTables' per-entry null.
  notifications: notificationPreferencesPatchSchema.nullable().optional(),
  // Merged field-wise (see UserSettingsService.mergeMemories): a listed field
  // replaces, an unlisted one is untouched, `null` clears that field, and
  // `memories: null` clears the whole namespace.
  memories: memoriesPreferencesPatchSchema.nullable().optional(),
});

// =============================================================================
// System Settings Schema
// =============================================================================

export const systemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  // Well-known global feature flag keys stored in this map (system-wide on/off, Admin-managed):
  //   - autoTagging: AI auto-tagging + description generation
  //   - faceRecognition: face detection / recognition
  //   - burstDetection: burst photo (similar pictures) detection
  //   - duplicateDetection: near-duplicate photo (visual/hash similarity) detection
  //   - locationInference: interpolate/extrapolate missing GPS coords from timeline anchors
  //   - socialMediaDetection: social-media video detection (OCR-based)
  //   - faceAutoArchive: auto-archive faces matching a previously-archived face
  //   - pictureEnhancement: AI picture enhancer
  //   - workflows: media workflow automation
  //   - memories: curated memory collections (On This Day, Trips, People, …)
  features: z.record(z.string(), z.boolean()),
  ai: z.object({
    features: z.object({
      search: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
      tagging: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
      embedding: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
      enhance: z.object({
        provider: z.string(),
        model: z.string(),
      }).nullable().default(null),
      // Memories title/subtitle/narrative generation (epic #300, issue #302).
      // Chat-capable provider+model, same nullable-object shape as `enhance`:
      // a half-filled pair is not a valid selection, so the whole object is
      // either present or null. Consumed by MemoryTitleService (#306).
      memories: z.object({
        provider: z.string(),
        model: z.string(),
      }).nullable().default(null),
    }),
  }),
  face: z.object({
    features: z.object({
      detection: z.object({
        provider: z.string().nullable().default(null),
        model: z.string().nullable().default(null),
      }).default({ provider: null, model: null }),
    }).default({ detection: { provider: null, model: null } }),
    video: z.object({
      enabled: z.boolean().default(true),
      sampleIntervalSeconds: z.number().int().min(1).max(60).default(5),
      maxFramesPerVideo: z.number().int().min(1).max(300).default(60),
    }).optional().default({ enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 }),
    autoArchive: z.object({
      matchThreshold: z.number().min(0.30).max(0.90).default(0.45),
    }).optional().default({ matchThreshold: 0.45 }),
  }).optional().default({ features: { detection: { provider: null, model: null } }, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 }, autoArchive: { matchThreshold: 0.45 } }),
  storage: z.object({
    activeProvider: z.string().default('s3'),
    insights: z.object({
      refreshIntervalHours: z.number().int().min(1).max(168).default(4),
    }).default({ refreshIntervalHours: 4 }),
    trash: z.object({
      retentionDays: z.number().int().min(1).max(365).default(30),
    }).default({ retentionDays: 30 }),
  }).optional().default({ activeProvider: 's3', insights: { refreshIntervalHours: 4 }, trash: { retentionDays: 30 } }),
  burst: z.object({
    timeGapSeconds: z.number().int().min(1).max(300).default(10),
    hashDistance: z.number().int().min(0).max(32).default(10),
    minGroupSize: z.number().int().min(2).max(20).default(3),
    autoResolveThreshold: z.number().int().min(0).max(100).default(60),
  }).optional().default({ timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3, autoResolveThreshold: 60 }),
  dedup: z.object({
    similarityThreshold: z.number().min(0.80).max(0.995).default(0.96),
    hashMaxDistance: z.number().int().min(0).max(16).default(6),
    knnCandidates: z.number().int().min(5).max(50).default(20),
    autoResolveThreshold: z.number().int().min(0).max(100).default(60),
  }).optional().default({ similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20, autoResolveThreshold: 60 }),
  locationInference: z.object({
    maxGapMinutes: z.number().int().min(1).max(1440).default(30),
    maxExtrapolationGapMinutes: z.number().int().min(1).max(240).default(10),
    autoApplyMaxGapMinutes: z.number().int().min(0).max(60).default(5),
    requireSameDevice: z.boolean().default(true),
    maxAnchorDistanceKm: z.number().min(0.1).max(100).default(2),
    maxImpliedSpeedKmh: z.number().min(10).max(1000).default(150),
    bulkAcceptThreshold: z.number().int().min(0).max(100).default(80),
  }).optional().default({
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
    bulkAcceptThreshold: 80,
  }),
  socialMedia: z.object({
    ocrEnabled: z.boolean().default(true),
    ocrLanguages: z.array(z.string().min(1)).min(1).max(5).default(['eng']),
    ocrMaxFrames: z.number().int().min(2).max(6).default(4),
    ocrTimeoutSeconds: z.number().int().min(10).max(300).default(60),
    minConfidence: z.number().min(0.5).max(1.0).default(0.8),
    maxDurationSeconds: z.number().int().min(60).max(3600).default(300),
    maxSizeBytes: z.number().int().min(10_000_000).default(500_000_000),
  }).optional().default({
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
    maxDurationSeconds: 300,
    maxSizeBytes: 500_000_000,
  }),
  geo: z.object({
    reverseProvider: z.enum(['offline', 'nominatim', 'google']).default('offline'),
    forwardSearchEnabled: z.boolean().default(false),
  }).optional().default({ reverseProvider: 'offline', forwardSearchEnabled: false }),
  // Transactional email (SES / SMTP). smtpPassword holds the AES-256-GCM
  // ENCRYPTED ciphertext — it is stripped from the generic system-settings
  // response and only ever returned masked (last-4) by the email-settings API.
  email: z.object({
    provider: z.enum(['ses', 'smtp']).nullable().default(null),
    enabled: z.boolean().default(false),
    sesRegion: z.string().nullable().default(null),
    smtpHost: z.string().nullable().default(null),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpUseTls: z.boolean().default(true),
    smtpUsername: z.string().nullable().default(null),
    smtpPassword: z.string().nullable().default(null),
    fromAddress: z.string().nullable().default(null),
    fromName: z.string().nullable().default(null),
  }).optional().default({
    provider: null,
    enabled: false,
    sesRegion: null,
    smtpHost: null,
    smtpPort: 587,
    smtpUseTls: true,
    smtpUsername: null,
    smtpPassword: null,
    fromAddress: null,
    fromName: null,
  }),
  jobs: z.object({
    history: z.object({
      retentionDays: z.number().int().min(1).max(365).default(30),
      purgeEnabled: z.boolean().default(true),
    }).default({ retentionDays: 30, purgeEnabled: true }),
    stuckThresholdMinutes: z.number().int().min(1).max(120).default(3),
  }).optional().default({ history: { retentionDays: 30, purgeEnabled: true }, stuckThresholdMinutes: 3 }),
  // Review-queue run history (issue #190). Retention for the shared
  // review_runs table AND trash_empty_runs — one setting retires both tables'
  // history through the single nightly review_run_history_purge job.
  reviewRuns: z.object({
    runHistoryRetentionDays: z.number().int().min(1).max(365).default(30),
  }).optional().default({ runHistoryRetentionDays: 30 }),
  // Notification Center retention (epic #240, issue #248). Drives the nightly
  // `notification_purge` job. NOTE the deliberate asymmetry with
  // jobs.history above: retentionDays ages out only rows the user has already
  // RESOLVED (dismissed_at / read_at). An UNREAD notification is never deleted
  // by age — see NotificationPurgeHandler.
  notifications: z.object({
    retentionDays: z.number().int().min(1).max(365).default(30),
    purgeEnabled: z.boolean().default(true),
  }).optional().default({ retentionDays: 30, purgeEnabled: true }),
  pictureEnhancement: z.object({
    defaultQuality: z.enum(['low', 'medium', 'high']).default('high'),
    defaultStrength: z.enum(['subtle', 'balanced', 'strong']).default('balanced'),
    stampExif: z.boolean().default(true),
    allowReplace: z.boolean().default(true),
    blockReplaceOnDownscale: z.boolean().default(false),
    maxInputMegapixels: z.number().min(1).max(100).default(50),
    // 168h (7 days). The enhancements hub is an inbox users work through over
    // time; a 3-day window destroyed staged previews before they were reviewed.
    retentionHours: z.number().int().min(1).max(720).default(168),
  }).optional().default({
    defaultQuality: 'high',
    defaultStrength: 'balanced',
    stampExif: true,
    allowReplace: true,
    blockReplaceOnDownscale: false,
    maxInputMegapixels: 50,
    retentionHours: 168,
  }),
  // Node backup change feed (issue #310, epic #308). Read by
  // NodeBackupQueryService via the cached getSettings() call.
  backup: z.object({
    maxPageSize: z.number().int().min(50).max(500).default(200),
    feedSafetyHorizonSeconds: z.number().int().min(0).max(60).default(5),
    runStaleMinutes: z.number().int().min(5).max(120).default(15),
  }).optional().default({
    maxPageSize: 200,
    feedSafetyHorizonSeconds: 5,
    runStaleMinutes: 15,
  }),
  // Media Workflow Automation (issue #139 / epic #138). The full namespace ships
  // here in Phase 1; later phases read these values via getSettings() without a
  // further schema change. Phase 1 actively reads maxItemsPerRun,
  // maxWorkflowsPerCircle, requirePreview, previewTtlHours (+ features.workflows).
  workflows: z.object({
    maxItemsPerRun: z.number().int().min(100).max(500000).default(10000),
    batchSize: z.number().int().min(50).max(1000).default(200),
    maxConcurrentRuns: z.number().int().min(1).max(10).default(2),
    requirePreview: z.boolean().default(true),
    allowHardDelete: z.boolean().default(false),
    maxWorkflowsPerCircle: z.number().int().min(1).max(100).default(20),
    previewTtlHours: z.number().int().min(1).max(168).default(24),
    runHistoryRetentionDays: z.number().int().min(1).max(365).default(30),
    triggers: z.object({
      onEnrichment: z.boolean().default(true),
      scheduled: z.boolean().default(true),
    }).default({ onEnrichment: true, scheduled: true }),
    scheduleMinIntervalMinutes: z.number().int().min(60).max(10080).default(60),
  }).optional().default({
    maxItemsPerRun: 10000,
    batchSize: 200,
    maxConcurrentRuns: 2,
    requirePreview: true,
    allowHardDelete: false,
    maxWorkflowsPerCircle: 20,
    previewTtlHours: 24,
    runHistoryRetentionDays: 30,
    triggers: { onEnrichment: true, scheduled: true },
    scheduleMinIntervalMinutes: 60,
  }),
  // Memories (epic #300, issue #302). The FULL namespace ships here alongside the
  // generation job skeleton so every later issue in the epic (curators #303–#305,
  // AI titles #306, API #307, digest #311, admin page #315) reads its parameters
  // through the one cached getSettings() call with no further schema change.
  // Issue #302 actively reads only generation.intervalHours (+ features.memories).
  memories: z.object({
    generation: z.object({
      intervalHours: z.number().int().min(1).max(168).default(24),
    }).default({ intervalHours: 24 }),
    maxItemsPerMemory: z.number().int().min(5).max(100).default(30),
    aiTitles: z.object({
      enabled: z.boolean().default(true),
    }).default({ enabled: true }),
    onThisDay: z.object({
      enabled: z.boolean().default(true),
      lookbackYears: z.number().int().min(1).max(50).default(10),
      minItems: z.number().int().min(1).max(20).default(3),
    }).default({ enabled: true, lookbackYears: 10, minItems: 3 }),
    trips: z.object({
      enabled: z.boolean().default(true),
      minDays: z.number().int().min(1).max(14).default(2),
      minItems: z.number().int().min(3).max(100).default(10),
      minDistanceKm: z.number().int().min(5).max(500).default(50),
      lookbackMonths: z.number().int().min(1).max(240).default(18),
    }).default({ enabled: true, minDays: 2, minItems: 10, minDistanceKm: 50, lookbackMonths: 18 }),
    people: z.object({
      enabled: z.boolean().default(true),
      favoritesOnly: z.boolean().default(true),
      minItems: z.number().int().min(3).max(50).default(8),
    }).default({ enabled: true, favoritesOnly: true, minItems: 8 }),
    themes: z.object({
      enabled: z.boolean().default(true),
      minItems: z.number().int().min(3).max(50).default(8),
      maxPerPeriod: z.number().int().min(1).max(10).default(3),
    }).default({ enabled: true, minItems: 8, maxPerPeriod: 3 }),
    seasonal: z.object({
      enabled: z.boolean().default(true),
      minItems: z.number().int().min(5).max(100).default(12),
    }).default({ enabled: true, minItems: 12 }),
    yearInReview: z.object({
      enabled: z.boolean().default(true),
      minItems: z.number().int().min(5).max(100).default(15),
    }).default({ enabled: true, minItems: 15 }),
    digest: z.object({
      enabled: z.boolean().default(true),
      frequency: z.enum(['off', 'daily', 'weekly', 'monthly']).default('weekly'),
      sendHourUtc: z.number().int().min(0).max(23).default(8),
      imageTokenTtlDays: z.number().int().min(7).max(90).default(30),
    }).default({ enabled: true, frequency: 'weekly', sendHourUtc: 8, imageTokenTtlDays: 30 }),
  }).optional().default({
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
  }),
  // PostgreSQL Database Backup & Restore (epic #339, issue #340). The full
  // namespace ships here as a schema-only foundation, mirroring the
  // `backup` (Local Media Backup) and `memories` precedents above — later
  // issues in the epic read these through the one cached getSettings() call
  // with no further schema change.
  databaseBackup: z.object({
    enabled: z.boolean().default(false),
    frequency: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
    dayOfWeek: z.number().int().min(0).max(6).default(0),
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeOfDay must be "HH:mm"')
      .default('02:00'),
    timezone: z.string().min(1).default('UTC'),
    retentionCount: z.number().int().min(1).max(100).default(7),
    storageProvider: z.string().nullable().default(null),
    runStaleMinutes: z.number().int().min(5).max(240).default(30),
    compressionLevel: z.number().int().min(0).max(9).default(1),
    restoreRollbackMode: z
      .enum(['retain_database', 'pre_restore_dump'])
      .default('retain_database'),
    oldDatabaseRetentionHours: z.number().int().min(1).max(720).default(168),
  }).optional().default({
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
  }),
});

export type SystemSettingsDto = z.infer<typeof systemSettingsSchema>;

// Partial schema for PATCH operations (zod v4: deepPartial removed, use manual deep partial)
export const systemSettingsPatchSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean().optional(),
  }).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  ai: z.object({
    features: z.object({
      search: z.object({
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }).optional(),
      tagging: z.object({
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }).optional(),
      embedding: z.object({
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }).optional(),
      enhance: z.object({
        provider: z.string(),
        model: z.string(),
      }).nullable().optional(),
      memories: z.object({
        provider: z.string(),
        model: z.string(),
      }).nullable().optional(),
    }).optional(),
  }).optional(),
  face: z.object({
    features: z.object({
      detection: z.object({
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }).optional(),
    }).optional(),
    video: z.object({
      enabled: z.boolean().optional(),
      sampleIntervalSeconds: z.number().int().min(1).max(60).optional(),
      maxFramesPerVideo: z.number().int().min(1).max(300).optional(),
    }).optional(),
    autoArchive: z.object({
      matchThreshold: z.number().min(0.30).max(0.90).optional(),
    }).optional(),
  }).optional(),
  storage: z.object({
    activeProvider: z.string().optional(),
    insights: z.object({
      refreshIntervalHours: z.number().int().min(1).max(168).optional(),
    }).optional(),
    trash: z.object({
      retentionDays: z.number().int().min(1).max(365).optional(),
    }).optional(),
  }).optional(),
  burst: z.object({
    timeGapSeconds: z.number().int().min(1).max(300).optional(),
    hashDistance: z.number().int().min(0).max(32).optional(),
    minGroupSize: z.number().int().min(2).max(20).optional(),
    autoResolveThreshold: z.number().int().min(0).max(100).optional(),
  }).optional(),
  dedup: z.object({
    similarityThreshold: z.number().min(0.80).max(0.995).optional(),
    hashMaxDistance: z.number().int().min(0).max(16).optional(),
    knnCandidates: z.number().int().min(5).max(50).optional(),
    autoResolveThreshold: z.number().int().min(0).max(100).optional(),
  }).optional(),
  locationInference: z.object({
    maxGapMinutes: z.number().int().min(1).max(1440).optional(),
    maxExtrapolationGapMinutes: z.number().int().min(1).max(240).optional(),
    autoApplyMaxGapMinutes: z.number().int().min(0).max(60).optional(),
    requireSameDevice: z.boolean().optional(),
    maxAnchorDistanceKm: z.number().min(0.1).max(100).optional(),
    maxImpliedSpeedKmh: z.number().min(10).max(1000).optional(),
    bulkAcceptThreshold: z.number().int().min(0).max(100).optional(),
  }).optional(),
  socialMedia: z.object({
    ocrEnabled: z.boolean().optional(),
    ocrLanguages: z.array(z.string().min(1)).min(1).max(5).optional(),
    ocrMaxFrames: z.number().int().min(2).max(6).optional(),
    ocrTimeoutSeconds: z.number().int().min(10).max(300).optional(),
    minConfidence: z.number().min(0.5).max(1.0).optional(),
    maxDurationSeconds: z.number().int().min(60).max(3600).optional(),
    maxSizeBytes: z.number().int().min(10_000_000).optional(),
  }).optional(),
  geo: z.object({
    reverseProvider: z.enum(['offline', 'nominatim', 'google']).optional(),
    forwardSearchEnabled: z.boolean().optional(),
  }).optional(),
  email: z.object({
    provider: z.enum(['ses', 'smtp']).nullable().optional(),
    enabled: z.boolean().optional(),
    sesRegion: z.string().nullable().optional(),
    smtpHost: z.string().nullable().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUseTls: z.boolean().optional(),
    smtpUsername: z.string().nullable().optional(),
    smtpPassword: z.string().nullable().optional(),
    fromAddress: z.string().nullable().optional(),
    fromName: z.string().nullable().optional(),
  }).optional(),
  jobs: z.object({
    history: z.object({
      retentionDays: z.number().int().min(1).max(365).optional(),
      purgeEnabled: z.boolean().optional(),
    }).optional(),
    stuckThresholdMinutes: z.number().int().min(1).max(120).optional(),
  }).optional(),
  reviewRuns: z.object({
    runHistoryRetentionDays: z.number().int().min(1).max(365).optional(),
  }).optional(),
  notifications: z.object({
    retentionDays: z.number().int().min(1).max(365).optional(),
    purgeEnabled: z.boolean().optional(),
  }).optional(),
  pictureEnhancement: z.object({
    defaultQuality: z.enum(['low', 'medium', 'high']).optional(),
    defaultStrength: z.enum(['subtle', 'balanced', 'strong']).optional(),
    stampExif: z.boolean().optional(),
    allowReplace: z.boolean().optional(),
    blockReplaceOnDownscale: z.boolean().optional(),
    maxInputMegapixels: z.number().min(1).max(100).optional(),
    retentionHours: z.number().int().min(1).max(720).optional(),
  }).optional(),
  backup: z.object({
    maxPageSize: z.number().int().min(50).max(500).optional(),
    feedSafetyHorizonSeconds: z.number().int().min(0).max(60).optional(),
    runStaleMinutes: z.number().int().min(5).max(120).optional(),
  }).optional(),
  workflows: z.object({
    maxItemsPerRun: z.number().int().min(100).max(500000).optional(),
    batchSize: z.number().int().min(50).max(1000).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
    requirePreview: z.boolean().optional(),
    allowHardDelete: z.boolean().optional(),
    maxWorkflowsPerCircle: z.number().int().min(1).max(100).optional(),
    previewTtlHours: z.number().int().min(1).max(168).optional(),
    runHistoryRetentionDays: z.number().int().min(1).max(365).optional(),
    triggers: z.object({
      onEnrichment: z.boolean().optional(),
      scheduled: z.boolean().optional(),
    }).optional(),
    scheduleMinIntervalMinutes: z.number().int().min(60).max(10080).optional(),
  }).optional(),
  // Memories (epic #300, issue #302) — all-optional twin of the namespace above.
  memories: z.object({
    generation: z.object({
      intervalHours: z.number().int().min(1).max(168).optional(),
    }).optional(),
    maxItemsPerMemory: z.number().int().min(5).max(100).optional(),
    aiTitles: z.object({
      enabled: z.boolean().optional(),
    }).optional(),
    onThisDay: z.object({
      enabled: z.boolean().optional(),
      lookbackYears: z.number().int().min(1).max(50).optional(),
      minItems: z.number().int().min(1).max(20).optional(),
    }).optional(),
    trips: z.object({
      enabled: z.boolean().optional(),
      minDays: z.number().int().min(1).max(14).optional(),
      minItems: z.number().int().min(3).max(100).optional(),
      minDistanceKm: z.number().int().min(5).max(500).optional(),
      lookbackMonths: z.number().int().min(1).max(240).optional(),
    }).optional(),
    people: z.object({
      enabled: z.boolean().optional(),
      favoritesOnly: z.boolean().optional(),
      minItems: z.number().int().min(3).max(50).optional(),
    }).optional(),
    themes: z.object({
      enabled: z.boolean().optional(),
      minItems: z.number().int().min(3).max(50).optional(),
      maxPerPeriod: z.number().int().min(1).max(10).optional(),
    }).optional(),
    seasonal: z.object({
      enabled: z.boolean().optional(),
      minItems: z.number().int().min(5).max(100).optional(),
    }).optional(),
    yearInReview: z.object({
      enabled: z.boolean().optional(),
      minItems: z.number().int().min(5).max(100).optional(),
    }).optional(),
    digest: z.object({
      enabled: z.boolean().optional(),
      frequency: z.enum(['off', 'daily', 'weekly', 'monthly']).optional(),
      sendHourUtc: z.number().int().min(0).max(23).optional(),
      imageTokenTtlDays: z.number().int().min(7).max(90).optional(),
    }).optional(),
  }).optional(),
  // PostgreSQL Database Backup & Restore (epic #339, issue #340) — all-optional
  // twin of the namespace above.
  databaseBackup: z.object({
    enabled: z.boolean().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeOfDay must be "HH:mm"')
      .optional(),
    timezone: z.string().min(1).optional(),
    retentionCount: z.number().int().min(1).max(100).optional(),
    storageProvider: z.string().nullable().optional(),
    runStaleMinutes: z.number().int().min(5).max(240).optional(),
    compressionLevel: z.number().int().min(0).max(9).optional(),
    restoreRollbackMode: z.enum(['retain_database', 'pre_restore_dump']).optional(),
    oldDatabaseRetentionHours: z.number().int().min(1).max(720).optional(),
  }).optional(),
});
