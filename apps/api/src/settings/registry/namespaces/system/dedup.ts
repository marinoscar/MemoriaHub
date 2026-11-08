import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  similarityThreshold: z.number().min(0.8).max(0.995),
  hashMaxDistance: z.number().int().min(0).max(16),
  knnCandidates: z.number().int().min(5).max(50),
  autoResolveThreshold: z.number().int().min(0).max(100),
});
export type DedupSettingsValue = z.infer<typeof schema>;

export const DEDUP_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'dedup',
  description: 'Near-duplicate detection: CLIP similarity, dHash distance, KNN candidates and the auto-resolve threshold.',
  schema,
  defaults: { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20, autoResolveThreshold: 60 },
});
