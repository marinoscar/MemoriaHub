import { api, ApiError } from './api';

// ---------------------------------------------------------------------------
// Types — AI Picture Enhancer (see docs/specs/picture-enhancer.md §4.1, §8)
// ---------------------------------------------------------------------------

export type EnhanceIntent = 'auto' | 'custom';
export type EnhanceStrength = 'subtle' | 'balanced' | 'strong';
export type ApplyDecision = 'keep_both' | 'replace';

export type EnhancementStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'applied'
  | 'discarded'
  | 'expired';

export interface EnhanceAdjustments {
  color?: boolean;
  tone?: boolean;
  sharpness?: boolean;
  denoise?: boolean;
  dehaze?: boolean;
  straighten?: boolean;
}

export interface EnhanceParams {
  intent?: EnhanceIntent;
  adjustments?: EnhanceAdjustments;
  strength?: EnhanceStrength;
  preserveFaces?: boolean;
  instructions?: string;
  model?: string;
}

/**
 * Image descriptor in the compare payload. Note: `size` is a STRING (bytes)
 * because the backend serializes BigInt-safe byte counts as strings.
 */
export interface EnhanceImageInfo {
  url: string | null;
  width: number | null;
  height: number | null;
  size: string | null;
}

export interface EnhancementDto {
  id: string;
  status: EnhancementStatus;
  model: string | null;
  original: EnhanceImageInfo | null;
  enhanced: EnhanceImageInfo | null;
  downscaled: boolean;
  params: EnhanceParams | null;
  lastError?: string | null;
}

export interface StartEnhanceResult {
  enhancementId: string;
  jobId: string;
  status: string;
}

/**
 * Response of the apply endpoint. `replace` returns `{ status, width, height }`;
 * `keep_both` returns the newly-created media item (id/mediaItemId). Kept loose
 * so a single caller can handle both decisions.
 */
export interface ApplyEnhancementResult {
  status?: string;
  width?: number;
  height?: number;
  id?: string;
  mediaItemId?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Start an enhancement job. An empty params object requests full auto defaults. */
export async function startEnhance(
  id: string,
  params: EnhanceParams = {},
): Promise<StartEnhanceResult> {
  return api.post<StartEnhanceResult>(`/media/${id}/enhance`, params);
}

/** Poll a single enhancement's status + compare payload. */
export async function getEnhancement(
  id: string,
  enhancementId: string,
): Promise<EnhancementDto> {
  return api.get<EnhancementDto>(`/media/${id}/enhance/${enhancementId}`);
}

/** Fetch the latest enhancement for an item (to resume a review after reload). */
export async function getLatestEnhancement(
  id: string,
): Promise<EnhancementDto | null> {
  try {
    return await api.get<EnhancementDto>(`/media/${id}/enhance`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Commit the result: create a new item (keep_both) or overwrite the original (replace). */
export async function applyEnhancement(
  id: string,
  enhancementId: string,
  decision: ApplyDecision,
): Promise<ApplyEnhancementResult> {
  return api.post<ApplyEnhancementResult>(
    `/media/${id}/enhance/${enhancementId}/apply`,
    { decision },
  );
}

/** Discard the staging preview (204). */
export async function discardEnhancement(
  id: string,
  enhancementId: string,
): Promise<void> {
  await api.post<void>(`/media/${id}/enhance/${enhancementId}/discard`);
}
