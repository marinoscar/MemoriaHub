// =============================================================================
// Harness for the settings contract spec (RETRO-B3, #614)
// =============================================================================
//
// The contract spec asserts what `GET|PATCH /api/system-settings` and
// `GET|PATCH /api/user-settings` DO, namespace by namespace, against an
// in-memory database. This file is the only part that knows which
// implementation is under test, so the same spec ran against the hand-written
// services before RETRO-B3 and runs against the platform settings slice after.
// =============================================================================

import { NotificationType } from '@prisma/client';

import { buildSettingsHarness as build, type SettingsHarness } from './settings-contract.subject';

export type { SettingsHarness };

/** Wipes the env vars that seed environment-dependent defaults. */
export function clearSettingsEnv(): void {
  for (const name of [
    'STORAGE_PROVIDER',
    'GEO_PROVIDER',
    'GEO_FORWARD_SEARCH_ENABLED',
    'ENRICHMENT_STUCK_MINUTES',
    'EMAIL_PROVIDER',
    'AWS_SES_REGION',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USE_TLS',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'EMAIL_FROM_ADDRESS',
    'EMAIL_FROM_NAME',
  ]) {
    delete process.env[name];
  }
}

export const buildSettingsHarness = build;

/** Every `NotificationType`, for the per-type merge cases. */
export const NOTIFICATION_TYPES = Object.values(NotificationType);

/**
 * The defaults every MemoriaHub system namespace had before RETRO-B3. Written
 * out by hand, NOT derived from the registry: this is the contract the
 * registry has to keep.
 */
export const EXPECTED_SYSTEM_DEFAULTS = {
  ui: { allowUserThemeOverride: true },
  features: {
    autoTagging: false,
    faceRecognition: false,
    burstDetection: false,
    duplicateDetection: false,
    locationInference: false,
    socialMediaDetection: false,
    faceAutoArchive: false,
    pictureEnhancement: false,
    workflows: false,
    memories: false,
    locationGrouping: false,
  },
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
      enhance: null,
      memories: null,
      transcription: null,
    },
  },
  autoTagging: {
    video: {
      enabled: false,
      maxFrames: 6,
      sampleIntervalSeconds: 5,
      transcription: { enabled: false, leadSeconds: 30 },
      streamInput: true,
    },
  },
  face: {
    providers: { compreface: { baseUrl: null, enabled: true } },
    features: { detection: { provider: null, model: null } },
    video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    autoArchive: { matchThreshold: 0.45 },
  },
  storage: {
    activeProvider: 's3',
    insights: { refreshIntervalHours: 4 },
    trash: { retentionDays: 30 },
  },
  burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3, autoResolveThreshold: 60 },
  dedup: { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20, autoResolveThreshold: 60 },
  locationInference: {
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
    bulkAcceptThreshold: 80,
  },
  locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm: 50, suggestionMinItems: 1 },
  socialMedia: {
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
    maxDurationSeconds: 300,
    maxSizeBytes: 500_000_000,
  },
  geo: { reverseProvider: 'offline', forwardSearchEnabled: false, google: { enabled: true, baseUrl: null } },
  email: {
    provider: null,
    enabled: false,
    sesRegion: null,
    smtpHost: null,
    smtpPort: 587,
    smtpUseTls: true,
    smtpUsername: null,
    fromAddress: null,
    fromName: null,
  },
  // The jobs slice's declarations (RETRO-C1); the stuck threshold's default is the platform's 30 (it was 3).
  jobs: { history: { retentionDays: 30, purgeEnabled: true }, stuckThresholdMinutes: 30 },
  retention: {
    notifications: { enabled: true, days: 180 },
    notificationDeliveries: { enabled: true, days: 90 },
    auditEvents: { enabled: false, days: 365 },
    aiRuns: { enabled: true, days: 90 },
  },
  reviewRuns: { runHistoryRetentionDays: 30 },
  notifications: {
    retentionDays: 30,
    purgeEnabled: true,
    browserEnabled: true,
    pushEnabled: true,
    disabledTypes: [],
  },
  pictureEnhancement: {
    defaultQuality: 'high',
    defaultStrength: 'balanced',
    stampExif: true,
    allowReplace: true,
    blockReplaceOnDownscale: false,
    maxInputMegapixels: 50,
    retentionHours: 168,
    maxBatchSize: 25,
  },
  backup: { maxPageSize: 200, feedSafetyHorizonSeconds: 5, runStaleMinutes: 15 },
  workflows: {
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
    // The platform declaration (RETRO-D4): '' is "no pin"; node offload stays off. The other three
    // are MemoriaHub's own defaults, kept by APP_SYSTEM_SETTINGS_DEFAULTS.
    storageProvider: '',
    runStaleMinutes: 30,
    compressionLevel: 1,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 168,
    nodeOffloadEnabled: false,
  },
  maintenance: { enabled: false, allowAdmins: true, startedAt: null, startedById: null },
} as const;
