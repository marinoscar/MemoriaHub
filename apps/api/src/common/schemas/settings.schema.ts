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
  }).optional().default({ features: { detection: { provider: null, model: null } } }),
  storage: z.object({
    insights: z.object({
      refreshIntervalHours: z.number().int().min(1).max(168).default(4),
    }).default({ refreshIntervalHours: 4 }),
  }).optional().default({ insights: { refreshIntervalHours: 4 } }),
  burst: z.object({
    timeGapSeconds: z.number().int().min(1).max(300).default(10),
    hashDistance: z.number().int().min(0).max(32).default(10),
    minGroupSize: z.number().int().min(2).max(20).default(3),
  }).optional().default({ timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 }),
  similarity: z.object({
    hashDistance: z.number().int().min(0).max(32).default(6),
    minGroupSize: z.number().int().min(2).max(20).default(2),
    maxGroupSize: z.number().int().min(2).max(200).default(50),
  }).optional().default({ hashDistance: 6, minGroupSize: 2, maxGroupSize: 50 }),
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
  }).optional(),
  storage: z.object({
    insights: z.object({
      refreshIntervalHours: z.number().int().min(1).max(168).optional(),
    }).optional(),
  }).optional(),
  burst: z.object({
    timeGapSeconds: z.number().int().min(1).max(300).optional(),
    hashDistance: z.number().int().min(0).max(32).optional(),
    minGroupSize: z.number().int().min(2).max(20).optional(),
  }).optional(),
  similarity: z.object({
    hashDistance: z.number().int().min(0).max(32).optional(),
    minGroupSize: z.number().int().min(2).max(20).optional(),
    maxGroupSize: z.number().int().min(2).max(200).optional(),
  }).optional(),
});
