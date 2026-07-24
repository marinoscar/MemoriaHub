import { z } from 'zod';

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
  pictureEnhancement: z.object({
    defaultQuality: z.enum(['low', 'medium', 'high']).default('high'),
    defaultStrength: z.enum(['subtle', 'balanced', 'strong']).default('balanced'),
    stampExif: z.boolean().default(false),
    allowReplace: z.boolean().default(true),
    blockReplaceOnDownscale: z.boolean().default(false),
    maxInputMegapixels: z.number().min(1).max(100).default(50),
    retentionHours: z.number().int().min(1).max(720).default(72),
  }).optional().default({
    defaultQuality: 'high',
    defaultStrength: 'balanced',
    stampExif: false,
    allowReplace: true,
    blockReplaceOnDownscale: false,
    maxInputMegapixels: 50,
    retentionHours: 72,
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
  pictureEnhancement: z.object({
    defaultQuality: z.enum(['low', 'medium', 'high']).optional(),
    defaultStrength: z.enum(['subtle', 'balanced', 'strong']).optional(),
    stampExif: z.boolean().optional(),
    allowReplace: z.boolean().optional(),
    blockReplaceOnDownscale: z.boolean().optional(),
    maxInputMegapixels: z.number().min(1).max(100).optional(),
    retentionHours: z.number().int().min(1).max(720).optional(),
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
});
