// PLATFORM-ADOPTION-SHIM(RETRO-E1): the AI slice swaps this for AI_SYSTEM_SETTINGS plus an
// extension carrying the fields below that the platform lacks.
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const selection = z.object({ provider: z.string().nullable(), model: z.string().nullable() });
// A half-filled provider/model pair is not a valid selection: the object is whole or null.
const pair = z.object({ provider: z.string(), model: z.string() }).nullable();

const schema = z.object({
  features: z.object({
    search: selection,
    tagging: selection,
    embedding: selection,
    // AI Picture Enhancer (OpenAI-only: gpt-image-1).
    enhance: pair,
    // Memories title/subtitle/narrative generation (epic #300). Chat-capable.
    memories: pair,
    // Speech-to-text for video auto-tagging (epic #452). OpenAI-only in v1; unset means visual-only.
    transcription: pair,
  }),
});
export type AiSettingsValue = z.infer<typeof schema>;

export const AI_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'ai',
  description: 'Which provider and model serve each AI feature (search, tagging, embedding, enhance, memories, transcription).',
  schema,
  defaults: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
      enhance: null,
      memories: null,
      transcription: null,
    },
  },
  // `search`, `tagging` and `embedding` always used `??`: an explicit null kept the stored value.
  keepOnNull: [
    'features.search.provider',
    'features.search.model',
    'features.tagging.provider',
    'features.tagging.model',
    'features.embedding.provider',
    'features.embedding.model',
  ],
});
