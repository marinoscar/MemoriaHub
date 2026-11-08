import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  ocrEnabled: z.boolean(),
  ocrLanguages: z.array(z.string().min(1)).min(1).max(5),
  ocrMaxFrames: z.number().int().min(2).max(6),
  ocrTimeoutSeconds: z.number().int().min(10).max(300),
  minConfidence: z.number().min(0.5).max(1),
  maxDurationSeconds: z.number().int().min(60).max(3600),
  maxSizeBytes: z.number().int().min(10_000_000),
});
export type SocialMediaSettingsValue = z.infer<typeof schema>;

export const SOCIAL_MEDIA_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'socialMedia',
  description: 'Social-media video detection: the OCR tier and the duration and size caps.',
  schema,
  defaults: {
    ocrEnabled: true,
    ocrLanguages: ['eng'],
    ocrMaxFrames: 4,
    ocrTimeoutSeconds: 60,
    minConfidence: 0.8,
    maxDurationSeconds: 300,
    maxSizeBytes: 500_000_000,
  },
});
