import { api, ApiError } from './api';

// ---------------------------------------------------------------------------
// Types — AI Picture Enhancer (see docs/specs/picture-enhancer.md §4.1, §8)
// ---------------------------------------------------------------------------

export type EnhanceIntent = 'auto' | 'custom';
export type EnhanceStrength = 'subtle' | 'balanced' | 'strong';
export type ApplyDecision = 'keep_both' | 'replace';

/**
 * Task-specific preset. ORTHOGONAL to `intent` — a preset steers WHAT kind of
 * photo problem is being solved, while `intent`/`adjustments`/`instructions`
 * still steer the individual corrections. See the API's `enhance-prompt.builder`.
 */
export type EnhancePreset =
  | 'restore_old_photo'
  | 'low_light'
  | 'colorize_bw'
  | 'portrait_polish';

/** Per-run override of the `pictureEnhancement.defaultQuality` system setting. */
export type EnhanceQuality = 'low' | 'medium' | 'high';

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
  /** Task-specific preset; independent of `intent`. Omit for the generic template. */
  preset?: EnhancePreset;
  adjustments?: EnhanceAdjustments;
  strength?: EnhanceStrength;
  /** Omit to let the server's `pictureEnhancement.defaultQuality` apply. */
  quality?: EnhanceQuality;
  preserveFaces?: boolean;
  /** Only honored by the server when `intent === 'custom'`. */
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

/**
 * Admin readiness snapshot for the AI Picture Enhancer
 * (`GET /api/admin/ai/enhance/status`). `ready` is true only when the feature
 * toggle is on AND a model is selected AND an enabled credential exists for the
 * resolved provider — the same three conditions the enhance endpoint enforces.
 */
export interface EnhancerAdminStatus {
  featureEnabled: boolean;
  provider: string | null;
  model: string | null;
  credentialConfigured: boolean;
  ready: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Admin: feature/provider readiness for the AI Picture Enhancer. */
export async function getEnhancerAdminStatus(): Promise<EnhancerAdminStatus> {
  return api.get<EnhancerAdminStatus>('/admin/ai/enhance/status');
}

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
