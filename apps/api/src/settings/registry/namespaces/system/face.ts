import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  features: z.object({
    detection: z.object({ provider: z.string().nullable(), model: z.string().nullable() }),
  }),
  video: z.object({
    enabled: z.boolean(),
    sampleIntervalSeconds: z.number().int().min(1).max(60),
    maxFramesPerVideo: z.number().int().min(1).max(300),
  }),
  autoArchive: z.object({
    // Same value as the cluster threshold (face-to-face geometry), stricter than the 0.38 centroid match.
    matchThreshold: z.number().min(0.3).max(0.9),
  }),
});
export type FaceSettingsValue = z.infer<typeof schema>;

export const FACE_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'face',
  description: 'Face detection provider, video frame sampling and the auto-archive match threshold.',
  schema,
  defaults: {
    features: { detection: { provider: null, model: null } },
    video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    autoArchive: { matchThreshold: 0.45 },
  },
  // `face.features.detection` always used `??`: an explicit null kept the stored value.
  keepOnNull: ['features.detection.provider', 'features.detection.model'],
});
