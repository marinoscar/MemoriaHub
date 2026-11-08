import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  defaultQuality: z.enum(['low', 'medium', 'high']),
  defaultStrength: z.enum(['subtle', 'balanced', 'strong']),
  stampExif: z.boolean(),
  allowReplace: z.boolean(),
  blockReplaceOnDownscale: z.boolean(),
  maxInputMegapixels: z.number().min(1).max(100),
  // 168h: the enhancements hub is an inbox users work through over time.
  retentionHours: z.number().int().min(1).max(720),
  // The AUTHORITATIVE cap on one bulk enhance request: each queued item is a separately billed call.
  maxBatchSize: z.number().int().min(1).max(200),
});
export type PictureEnhancementSettingsValue = z.infer<typeof schema>;

export const PICTURE_ENHANCEMENT_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'pictureEnhancement',
  description: 'AI Picture Enhancer defaults, replace policy, input cap, retention and the bulk batch cap.',
  schema,
  defaults: {
    defaultQuality: 'high',
    defaultStrength: 'balanced',
    stampExif: true,
    allowReplace: true,
    blockReplaceOnDownscale: false,
    maxInputMegapixels: 50,
    retentionHours: 168,
    maxBatchSize: 25,
  },
});
