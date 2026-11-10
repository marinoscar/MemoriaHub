import { AiError, classifyOpenAiModel, type AiSystemScope } from '@marinoscar/platform-api/ai';
import type { RateLimitError as PlatformRateLimitError } from '@marinoscar/platform-api/jobs';

import { EMBEDDING_STORAGE_DIMENSIONS, type MemoriaHubAiFeatureId } from './ai-features';

// =============================================================================
// Shared pieces of a MemoriaHub AI call (RETRO-E2, #601)
// =============================================================================
//
// What every call site repeats around `AiService.forUser|forSystem(...)`, kept here so the six
// sites cannot drift: the system scope, the rate-limit translation, the per-provider vision budget
// the old provider adapters applied, and the embedding dimension guard.
// =============================================================================

/**
 * The scope of a call a background job makes (no acting user).
 *
 * `orgId: null` is the single-organization default (`AiSystemScope`): MemoriaHub runs one
 * organization per deployment until RETRO-MULTI-ORG, the same fallback `DefaultOrgId` documents.
 * PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG): multi-organization mode needs the job's organization here.
 */
export function systemScope(feature: MemoriaHubAiFeatureId, jobId?: string): AiSystemScope {
  return { orgId: null, feature, ...(jobId ? { jobId } : {}) };
}

/**
 * The error a job handler should throw for an AI failure: the platform `RateLimitError` for a
 * provider throttle (HTTP 429, and Anthropic's 529: the jobs slice DEFERS the job without charging
 * an attempt), the error itself otherwise. Replaces `classifyRateLimit` for AI calls.
 */
export function asJobError(err: unknown): unknown {
  if (err instanceof AiError) return err.toRateLimitError() ?? err;
  return err;
}

/** The platform rate-limit signal in `err`, or null: `AiError('AI_RATE_LIMITED')` only. */
export function aiRateLimit(err: unknown): PlatformRateLimitError | null {
  return err instanceof AiError ? err.toRateLimitError() : null;
}

/** Output token budgets the old provider adapters used for a vision call, per provider. */
const OPENAI_VISION_MAX_TOKENS = 4096;
const ANTHROPIC_VISION_MAX_TOKENS = 1024;

/**
 * `low` is the lowest reasoning tier every GPT-5.x model the picker allows accepts. Sent only to a
 * model the catalogue knows reasons, so a non-reasoning model never receives a parameter it would
 * refuse (`requiredCapabilities` adds `reasoning` for a request that carries one).
 */
const OPENAI_REASONING_EFFORT = (process.env['OPENAI_REASONING_EFFORT'] ?? 'low') as
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high';

/** `maxOutputTokens` (and, for a reasoning OpenAI model, `reasoning`) of a vision call. */
export function visionCallOptions(
  provider: string,
  model: string,
  maxTokens?: number,
): { maxOutputTokens: number; reasoning?: { effort: typeof OPENAI_REASONING_EFFORT } } {
  const maxOutputTokens =
    maxTokens ?? (provider === 'anthropic' ? ANTHROPIC_VISION_MAX_TOKENS : OPENAI_VISION_MAX_TOKENS);
  const reasons =
    provider === 'openai' && classifyOpenAiModel(model)?.capabilities.includes('reasoning') === true;
  return { maxOutputTokens, ...(reasons ? { reasoning: { effort: OPENAI_REASONING_EFFORT } } : {}) };
}

/**
 * Refuses a vector the storage cannot hold. `media_item_embedding.embedding` is `vector(1536)`: a
 * model answering another size cannot be written, and a query vector of another size cannot be
 * compared, so the call fails with a plain message instead of a pgvector error.
 */
export function assertEmbeddingDimensions(vector: readonly number[], model: string): void {
  if (vector.length !== EMBEDDING_STORAGE_DIMENSIONS) {
    throw new Error(
      `Embedding model "${model}" returned ${vector.length}-d vectors but storage expects ` +
        `${EMBEDDING_STORAGE_DIMENSIONS}-d; use text-embedding-3-small.`,
    );
  }
}
