import { EMBEDDING_STORAGE_DIMENSIONS } from './constants.js';

// =============================================================================
// Shared pieces of a tagging or search model call (RETRO-J7, #618)
// =============================================================================
//
// What every call site repeats around `MEMORIAHUB_AI`, kept here so the sites cannot drift: the
// per-provider vision budget the old provider adapters applied, the reasoning hint, and the
// embedding dimension guard.
// =============================================================================

/** Output token budgets the old provider adapters used for a vision call, per provider. */
const OPENAI_VISION_MAX_TOKENS = 4096;
const ANTHROPIC_VISION_MAX_TOKENS = 1024;

/**
 * `low` is the lowest reasoning tier every GPT-5.x model the picker allows accepts. The port sends it
 * only to a model the host's catalogue knows reasons (`MemoriahubAiRequest.reasoning`).
 */
const OPENAI_REASONING_EFFORT = (process.env['OPENAI_REASONING_EFFORT'] ?? 'low') as 'minimal' | 'low' | 'medium' | 'high';

/**
 * `maxOutputTokens` (and, for an OpenAI model, the `reasoning` hint the host drops for a model that
 * does not reason) of a vision call.
 *
 * @param provider - the provider id of the tagging selection.
 * @param _model - the model id (the host decides whether it reasons).
 * @param maxTokens - an explicit budget (video tagging).
 * @returns the call options.
 * @stability experimental
 */
export function visionCallOptions(
  provider: string,
  _model: string,
  maxTokens?: number,
): { maxOutputTokens: number; reasoning?: { effort: typeof OPENAI_REASONING_EFFORT } } {
  const maxOutputTokens = maxTokens ?? (provider === 'anthropic' ? ANTHROPIC_VISION_MAX_TOKENS : OPENAI_VISION_MAX_TOKENS);
  return { maxOutputTokens, ...(provider === 'openai' ? { reasoning: { effort: OPENAI_REASONING_EFFORT } } : {}) };
}

/**
 * Refuses a vector the storage cannot hold. `media_item_embedding.embedding` is `vector(1536)`: a
 * model answering another size cannot be written, and a query vector of another size cannot be
 * compared, so the call fails with a plain message instead of a pgvector error.
 *
 * @param vector - what the model returned.
 * @param model - the model id, for the message.
 * @throws Error when the vector is not 1536-d.
 * @stability experimental
 */
export function assertEmbeddingDimensions(vector: readonly number[], model: string): void {
  if (vector.length !== EMBEDDING_STORAGE_DIMENSIONS) {
    throw new Error(
      `Embedding model "${model}" returned ${vector.length}-d vectors but storage expects ` +
        `${EMBEDDING_STORAGE_DIMENSIONS}-d; use text-embedding-3-small.`,
    );
  }
}
