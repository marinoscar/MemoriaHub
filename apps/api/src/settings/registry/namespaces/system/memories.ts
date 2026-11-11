import { z } from 'zod';
import { DEFAULT_MEMORIES_SETTINGS } from '@marinoscar/memoriahub-api/memories';

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
  // One source of the defaults: the memories slice resolves a partial stored namespace over the same constant.
  defaults: structuredClone(DEFAULT_MEMORIES_SETTINGS),
});
