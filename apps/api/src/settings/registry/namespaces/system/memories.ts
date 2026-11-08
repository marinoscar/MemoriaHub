import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

// The full namespace ships at once so every curator, the AI titling, the digest and the admin page read
// their parameters through one cached settings read. `features.memories` is the master switch.
const schema = z.object({
  generation: z.object({ intervalHours: z.number().int().min(1).max(168) }),
  maxItemsPerMemory: z.number().int().min(5).max(100),
  aiTitles: z.object({ enabled: z.boolean() }),
  onThisDay: z.object({
    enabled: z.boolean(),
    lookbackYears: z.number().int().min(1).max(50),
    minItems: z.number().int().min(1).max(20),
  }),
  trips: z.object({
    enabled: z.boolean(),
    minDays: z.number().int().min(1).max(14),
    minItems: z.number().int().min(3).max(100),
    minDistanceKm: z.number().int().min(5).max(500),
    lookbackMonths: z.number().int().min(1).max(240),
  }),
  people: z.object({
    enabled: z.boolean(),
    favoritesOnly: z.boolean(),
    minItems: z.number().int().min(3).max(50),
  }),
  themes: z.object({
    enabled: z.boolean(),
    minItems: z.number().int().min(3).max(50),
    maxPerPeriod: z.number().int().min(1).max(10),
  }),
  seasonal: z.object({ enabled: z.boolean(), minItems: z.number().int().min(5).max(100) }),
  yearInReview: z.object({ enabled: z.boolean(), minItems: z.number().int().min(5).max(100) }),
  digest: z.object({
    enabled: z.boolean(),
    frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
    sendHourUtc: z.number().int().min(0).max(23),
    imageTokenTtlDays: z.number().int().min(7).max(90),
  }),
});
export type MemoriesSettingsValue = z.infer<typeof schema>;

export const MEMORIES_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'memories',
  description: 'Memories generation cadence, per-type curation thresholds, AI titling and the email digest.',
  schema,
  defaults: {
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
});
