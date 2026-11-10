// =============================================================================
// MemoriaHub's AI features: ids and the settings key each one reads (RETRO-E2, #601)
// =============================================================================
//
// A leaf file (no import of the application graph): `app-registrations/ai.ts` registers
// the features from it at module load, and the call sites name them through
// `MEMORIAHUB_AI_FEATURES`. ⚠ A FEATURE ID IS PERMANENT once usage rows carry it
// (`ai_usage_events.feature`): lower snake case, never reused for something else.
// =============================================================================

export const MEMORIAHUB_AI_FEATURES = {
  /** Agentic search (`POST /api/search/agent`): chat, streaming, the `search_media` tool. */
  searchAgent: 'search_agent',
  /** Photo auto-tagging (`auto_tagging`): one image in, tags and a description out. */
  mediaTagging: 'media_tagging',
  /** Video auto-tagging (`video_auto_tagging`): several frames (and a transcript) in. */
  videoTagging: 'video_tagging',
  /** Text embeddings: the `media_item_embedding` writes and the `semanticQuery` search. */
  semanticEmbedding: 'semantic_embedding',
  /** The AI Picture Enhancer (`picture_enhancement`): one image edit. */
  pictureEnhance: 'picture_enhance',
  /** Speech-to-text of a video's opening seconds (video tagging). */
  videoTranscription: 'video_transcription',
  /** Memory titles, subtitles and narratives (`memory_generation`). */
  memoryTitles: 'memory_titles',
} as const;

export type MemoriaHubAiFeatureId = (typeof MEMORIAHUB_AI_FEATURES)[keyof typeof MEMORIAHUB_AI_FEATURES];

/** The key of the `ai.features` selection that routes a feature (`ai.features.<key>`). */
export type AiFeatureSelectionKey = 'search' | 'tagging' | 'embedding' | 'enhance' | 'memories' | 'transcription';

/**
 * Which selection routes which feature. The six selections predate the platform feature ids; the
 * two tagging features share `tagging`, exactly as they always did.
 */
export const AI_FEATURE_SELECTION: Readonly<Record<MemoriaHubAiFeatureId, AiFeatureSelectionKey>> = {
  search_agent: 'search',
  media_tagging: 'tagging',
  video_tagging: 'tagging',
  semantic_embedding: 'embedding',
  picture_enhance: 'enhance',
  video_transcription: 'transcription',
  memory_titles: 'memories',
};

export function isMemoriaHubAiFeature(id: string | undefined): id is MemoriaHubAiFeatureId {
  return id !== undefined && Object.prototype.hasOwnProperty.call(AI_FEATURE_SELECTION, id);
}

/**
 * The vector size `media_item_embedding.embedding` (`vector(1536)`) holds. A model that answers
 * another size cannot be stored, so an embedding call refuses it (`embedWithGuard`).
 */
export const EMBEDDING_STORAGE_DIMENSIONS = 1536;
