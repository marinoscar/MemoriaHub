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
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
