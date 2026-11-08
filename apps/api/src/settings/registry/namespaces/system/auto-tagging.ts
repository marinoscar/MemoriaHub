import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

// Video AI auto-tagging (epic #452). Mirrors `face.video.*` but is deliberately NOT coupled to it:
// face detection wants ~60 frames, AI tagging wants ~6 because each frame is a BILLED image.
// No env kill-switch of its own: video tagging rides on AUTO_TAG_ENABLED.
const schema = z.object({
  video: z.object({
    // Default FALSE: upgrading must produce zero new spend until an admin opts in.
    enabled: z.boolean(),
    // The dominant cost lever, and duration-independent.
    maxFrames: z.number().int().min(1).max(20),
    sampleIntervalSeconds: z.number().int().min(1).max(60),
    transcription: z.object({
      enabled: z.boolean(),
      // First N seconds of audio only, fixed regardless of runtime.
      leadSeconds: z.number().int().min(5).max(600),
    }),
    // Read the video from a presigned URL via HTTP range seeks (issue #456); the download path is the fallback.
    streamInput: z.boolean(),
  }),
});
export type AutoTaggingSettingsValue = z.infer<typeof schema>;

export const AUTO_TAGGING_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'autoTagging',
  description: 'Video AI auto-tagging cost bounds (frames, transcription, streaming input).',
  schema,
  defaults: {
    video: {
      enabled: false,
      maxFrames: 6,
      sampleIntervalSeconds: 5,
      transcription: { enabled: false, leadSeconds: 30 },
      streamInput: true,
    },
  },
});
