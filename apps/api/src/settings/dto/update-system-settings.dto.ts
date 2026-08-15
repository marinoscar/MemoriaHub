import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Full replacement (PUT)
export const updateSystemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  features: z.record(z.string(), z.boolean()),
  ai: z.object({
    features: z.object({
      search: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
    }),
  }),
  face: z.object({
    features: z.object({
      detection: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
    }),
    autoArchive: z
      .object({
        matchThreshold: z.number().min(0.30).max(0.90),
      })
      .optional(),
  }).optional(),
});

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

// Partial update (PATCH)
// .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
export const patchSystemSettingsSchema = z.object({
  ui: z
    .object({
      allowUserThemeOverride: z.boolean().optional(),
    })
    .optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  ai: z
    .object({
      features: z
        .object({
          search: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
          tagging: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
          embedding: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
          enhance: z
            .object({
              provider: z.string(),
              model: z.string(),
            })
            .nullable()
            .optional(),
          memories: z
            .object({
              provider: z.string(),
              model: z.string(),
            })
            .nullable()
            .optional(),
        })
        .optional(),
    })
    .optional(),
  face: z
    .object({
      features: z
        .object({
          detection: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      video: z
        .object({
          enabled: z.boolean().optional(),
          sampleIntervalSeconds: z.number().int().min(1).max(60).optional(),
          maxFramesPerVideo: z.number().int().min(1).max(300).optional(),
        })
        .optional(),
      autoArchive: z
        .object({
          matchThreshold: z.number().min(0.30).max(0.90).optional(),
        })
        .optional(),
    })
    .optional(),
  jobs: z
    .object({
      history: z
        .object({
          retentionDays: z.number().int().min(1).max(365).optional(),
          purgeEnabled: z.boolean().optional(),
        })
        .optional(),
      stuckThresholdMinutes: z.number().int().min(1).max(120).optional(),
    })
    .optional(),
  reviewRuns: z
    .object({
      runHistoryRetentionDays: z.number().int().min(1).max(365).optional(),
    })
    .optional(),
  notifications: z
    .object({
      retentionDays: z.number().int().min(1).max(365).optional(),
      purgeEnabled: z.boolean().optional(),
    })
    .optional(),
  storage: z
    .object({
      activeProvider: z.string().optional(),
      insights: z
        .object({
          refreshIntervalHours: z.number().int().min(1).max(168).optional(),
        })
        .optional(),
      trash: z
        .object({
          retentionDays: z.number().int().min(1).max(365).optional(),
        })
        .optional(),
    })
    .optional(),
  burst: z
    .object({
      timeGapSeconds: z.number().int().min(1).max(300).optional(),
      hashDistance: z.number().int().min(0).max(32).optional(),
      minGroupSize: z.number().int().min(2).max(20).optional(),
      autoResolveThreshold: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  dedup: z
    .object({
      similarityThreshold: z.number().min(0.8).max(0.995).optional(),
      hashMaxDistance: z.number().int().min(0).max(16).optional(),
      knnCandidates: z.number().int().min(5).max(50).optional(),
      autoResolveThreshold: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  locationInference: z
    .object({
      maxGapMinutes: z.number().int().min(1).max(1440).optional(),
      maxExtrapolationGapMinutes: z.number().int().min(1).max(240).optional(),
      autoApplyMaxGapMinutes: z.number().int().min(0).max(60).optional(),
      requireSameDevice: z.boolean().optional(),
      maxAnchorDistanceKm: z.number().min(0.1).max(100).optional(),
      maxImpliedSpeedKmh: z.number().min(10).max(1000).optional(),
    })
    .optional(),
  // Location Grouping (issue #373). THIS COPY IS LOAD-BEARING: this schema is
  // what nestjs-zod validates the PATCH body against, and it STRIPS UNKNOWN
  // KEYS — a namespace present in settings.schema.ts but missing here validates
  // and merges perfectly in unit tests while every real PATCH silently no-ops.
  locationGrouping: z
    .object({
      radiusCaptureEnabled: z.boolean().optional(),
      maxRadiusKm: z.number().min(0.5).max(200).optional(),
      suggestionMinItems: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  socialMedia: z
    .object({
      ocrEnabled: z.boolean().optional(),
      ocrLanguages: z.array(z.string().min(1)).min(1).max(5).optional(),
      ocrMaxFrames: z.number().int().min(2).max(6).optional(),
      ocrTimeoutSeconds: z.number().int().min(10).max(300).optional(),
      minConfidence: z.number().min(0.5).max(1.0).optional(),
      maxDurationSeconds: z.number().int().min(60).max(3600).optional(),
      maxSizeBytes: z.number().int().min(10_000_000).optional(),
    })
    .optional(),
  geo: z
    .object({
      reverseProvider: z.enum(['offline', 'nominatim', 'google']).optional(),
      forwardSearchEnabled: z.boolean().optional(),
    })
    .optional(),
  pictureEnhancement: z
    .object({
      defaultQuality: z.enum(['low', 'medium', 'high']).optional(),
      defaultStrength: z.enum(['subtle', 'balanced', 'strong']).optional(),
      stampExif: z.boolean().optional(),
      allowReplace: z.boolean().optional(),
      blockReplaceOnDownscale: z.boolean().optional(),
      maxInputMegapixels: z.number().min(1).max(100).optional(),
      retentionHours: z.number().int().min(1).max(720).optional(),
      maxBatchSize: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  // Memories (epic #300, issue #302). NOTE: this is the THIRD hand-maintained
  // copy of the namespace (systemSettingsSchema + systemSettingsPatchSchema in
  // common/schemas/settings.schema.ts are the other two). This one is the wire
  // DTO, so a key missing HERE is silently stripped from the request body
  // before the service ever sees it — a namespace added only to the other two
  // would appear to work while every PATCH quietly no-ops.
  memories: z
    .object({
      generation: z
        .object({
          intervalHours: z.number().int().min(1).max(168).optional(),
        })
        .optional(),
      maxItemsPerMemory: z.number().int().min(5).max(100).optional(),
      aiTitles: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
      onThisDay: z
        .object({
          enabled: z.boolean().optional(),
          lookbackYears: z.number().int().min(1).max(50).optional(),
          minItems: z.number().int().min(1).max(20).optional(),
        })
        .optional(),
      trips: z
        .object({
          enabled: z.boolean().optional(),
          minDays: z.number().int().min(1).max(14).optional(),
          minItems: z.number().int().min(3).max(100).optional(),
          minDistanceKm: z.number().int().min(5).max(500).optional(),
          lookbackMonths: z.number().int().min(1).max(240).optional(),
        })
        .optional(),
      people: z
        .object({
          enabled: z.boolean().optional(),
          favoritesOnly: z.boolean().optional(),
          minItems: z.number().int().min(3).max(50).optional(),
        })
        .optional(),
      themes: z
        .object({
          enabled: z.boolean().optional(),
          minItems: z.number().int().min(3).max(50).optional(),
          maxPerPeriod: z.number().int().min(1).max(10).optional(),
        })
        .optional(),
      seasonal: z
        .object({
          enabled: z.boolean().optional(),
          minItems: z.number().int().min(5).max(100).optional(),
        })
        .optional(),
      yearInReview: z
        .object({
          enabled: z.boolean().optional(),
          minItems: z.number().int().min(5).max(100).optional(),
        })
        .optional(),
      digest: z
        .object({
          enabled: z.boolean().optional(),
          frequency: z.enum(['off', 'daily', 'weekly', 'monthly']).optional(),
          sendHourUtc: z.number().int().min(0).max(23).optional(),
          imageTokenTtlDays: z.number().int().min(7).max(90).optional(),
        })
        .optional(),
    })
    .optional(),
  // PostgreSQL Database Backup & Restore (epic #339, issue #340). Same THIRD
  // hand-maintained copy caveat as the `memories` comment above — a key
  // missing HERE is silently stripped from the request body before the
  // service ever sees it.
  databaseBackup: z
    .object({
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
    })
    .optional(),
  // Admin-controlled maintenance mode (issue #348). Same THIRD hand-maintained
  // copy caveat as `databaseBackup`/`memories` above — a key missing HERE is
  // silently stripped from the request body before the service ever sees it.
  maintenance: z
    .object({
      enabled: z.boolean().optional(),
      message: z.string().max(500).optional(),
      allowAdmins: z.boolean().optional(),
      startedAt: z.string().nullable().optional(),
      startedById: z.string().nullable().optional(),
    })
    .optional(),
}).default({});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
