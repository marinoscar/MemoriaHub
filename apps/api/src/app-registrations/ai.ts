// =============================================================================
// MemoriaHub's AI features (RETRO-E2, #601)
// =============================================================================
//
// Every place this product calls a model is a registered AI feature (`registerAiFeature`): the
// platform stamps the feature id on the usage row (so `GET /api/admin/ai/usage` groups by it),
// checks the feature's `needs` against the chosen model's capabilities, lists it at
// `GET /api/ai/features`, and routes it through `AI_TARGET_RESOLVER` (`MemoriaHubAiTargetResolver`:
// the `ai.features.*` selection an administrator saved).
//
// `systemCalls: true` on every feature a background job or an importer runs with no acting user
// (`AiService.forSystem`: the organization's key, else the deployment's, never a user's). The
// search agent is the one feature a user always drives, so it stays user-only.
//
// ⚠ A FEATURE ID IS PERMANENT once usage rows carry it. Lower snake case. Ids: `ai-features.ts`.
//
// Imported once, from `platform/ai/ai.config.ts`, at module load: the registry freezes when the
// application bootstraps, so a registration from a service would fail with `FROZEN`.
// =============================================================================

import { registerAiFeature } from '@marinoscar/platform-api/ai';

import { MEMORIAHUB_AI_FEATURES as F } from '../ai-port/ai-features';

registerAiFeature({
  id: F.searchAgent,
  label: 'Agentic search',
  group: 'Search',
  needs: ['responses', 'tools', 'streaming'],
});

registerAiFeature({
  id: F.mediaTagging,
  label: 'Photo AI tagging',
  group: 'Tagging',
  needs: ['responses', 'vision_input'],
  inputModalities: ['image'],
  systemCalls: true,
});

registerAiFeature({
  id: F.videoTagging,
  label: 'Video AI tagging',
  group: 'Tagging',
  needs: ['responses', 'vision_input'],
  inputModalities: ['image'],
  systemCalls: true,
});

registerAiFeature({
  id: F.semanticEmbedding,
  label: 'Semantic search embeddings',
  group: 'Search',
  needs: ['embeddings'],
  systemCalls: true,
});

registerAiFeature({
  id: F.pictureEnhance,
  label: 'AI Picture Enhancer',
  group: 'Media',
  needs: ['image_edit'],
  systemCalls: true,
});

registerAiFeature({
  id: F.videoTranscription,
  label: 'Video transcription',
  group: 'Tagging',
  needs: ['audio_transcription'],
  systemCalls: true,
});

registerAiFeature({
  id: F.memoryTitles,
  label: 'Memory titles',
  group: 'Memories',
  needs: ['responses'],
  systemCalls: true,
});
