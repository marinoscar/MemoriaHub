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
  }).optional().default({ features: { detection: { provider: null, model: null } }, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 } }),
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
  }).optional().default({ timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 }),
  dedup: z.object({
    similarityThreshold: z.number().min(0.80).max(0.995).default(0.96),
    hashMaxDistance: z.number().int().min(0).max(16).default(6),
    knnCandidates: z.number().int().min(5).max(50).default(20),
  }).optional().default({ similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20 }),
  locationInference: z.object({
    maxGapMinutes: z.number().int().min(1).max(1440).default(30),
    maxExtrapolationGapMinutes: z.number().int().min(1).max(240).default(10),
    autoApplyMaxGapMinutes: z.number().int().min(0).max(60).default(5),
    requireSameDevice: z.boolean().default(true),
    maxAnchorDistanceKm: z.number().min(0.1).max(100).default(2),
    maxImpliedSpeedKmh: z.number().min(10).max(1000).default(150),
  }).optional().default({
    maxGapMinutes: 30,
    maxExtrapolationGapMinutes: 10,
    autoApplyMaxGapMinutes: 5,
    requireSameDevice: true,
    maxAnchorDistanceKm: 2,
    maxImpliedSpeedKmh: 150,
  }),
  socialMedia: z.object({
    ocrEnabled: z.boolean().default(true),
    ocrLanguages: z.array(z.string().min(1)).min(1).max(5).default(['eng']),
    ocrMaxFrames: z.number().int().min(2).max(6).default(4),
    ocrTimeoutSeconds: z.number().int().min(10).max(300).default(60),
    minConfidence: z.number().min(0.5).max(1.0).default(0.8),
  }).optional().default({
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
  }),
  geo: z.object({
    reverseProvider: z.enum(['offline', 'nominatim', 'google']).default('offline'),
    forwardSearchEnabled: z.boolean().default(false),
  }).optional().default({ reverseProvider: 'offline', forwardSearchEnabled: false }),
  jobs: z.object({
    history: z.object({
      retentionDays: z.number().int().min(1).max(365).default(30),
      purgeEnabled: z.boolean().default(true),
    }).default({ retentionDays: 30, purgeEnabled: true }),
  }).optional().default({ history: { retentionDays: 30, purgeEnabled: true } }),
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
  }).optional(),
  dedup: z.object({
    similarityThreshold: z.number().min(0.80).max(0.995).optional(),
    hashMaxDistance: z.number().int().min(0).max(16).optional(),
    knnCandidates: z.number().int().min(5).max(50).optional(),
  }).optional(),
  locationInference: z.object({
    maxGapMinutes: z.number().int().min(1).max(1440).optional(),
    maxExtrapolationGapMinutes: z.number().int().min(1).max(240).optional(),
    autoApplyMaxGapMinutes: z.number().int().min(0).max(60).optional(),
    requireSameDevice: z.boolean().optional(),
    maxAnchorDistanceKm: z.number().min(0.1).max(100).optional(),
    maxImpliedSpeedKmh: z.number().min(10).max(1000).optional(),
  }).optional(),
  socialMedia: z.object({
    ocrEnabled: z.boolean().optional(),
    ocrLanguages: z.array(z.string().min(1)).min(1).max(5).optional(),
    ocrMaxFrames: z.number().int().min(2).max(6).optional(),
    ocrTimeoutSeconds: z.number().int().min(10).max(300).optional(),
    minConfidence: z.number().min(0.5).max(1.0).optional(),
  }).optional(),
  geo: z.object({
    reverseProvider: z.enum(['offline', 'nominatim', 'google']).optional(),
    forwardSearchEnabled: z.boolean().optional(),
  }).optional(),
  jobs: z.object({
    history: z.object({
      retentionDays: z.number().int().min(1).max(365).optional(),
      purgeEnabled: z.boolean().optional(),
    }).optional(),
  }).optional(),
});
