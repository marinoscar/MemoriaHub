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

// ---------------------------------------------------------------------------
// Types — cross-item hub listing (issue #201)
// GET /api/media/enhancements
// ---------------------------------------------------------------------------

/**
 * `status` values the list endpoint accepts. On top of the seven concrete
 * `EnhancementStatus` values it takes three server-side aliases that expand to
 * a group (see `list-enhancements-query.dto.ts`), so the client can ask for
 * "everything still working" without hard-coding which statuses that means.
 */
export type EnhancementStatusFilter =
  | EnhancementStatus
  | 'in_progress'
  | 'awaiting_decision'
  | 'terminal';

/** Columns the list endpoint can order by (server default: `createdAt`). */
export type EnhancementSortBy = 'createdAt' | 'updatedAt';
export type EnhancementSortOrder = 'asc' | 'desc';

/**
 * Image descriptor in a LIST row. Deliberately NOT `EnhanceImageInfo`: the list
 * endpoint returns a signed *thumbnail* URL (`thumbnailUrl`) suited to a grid,
 * where the single-item compare payload returns a full-resolution `url`. Same
 * BigInt-as-string caveat applies to `size`.
 */
export interface EnhancementThumbInfo {
  thumbnailUrl: string | null;
  /**
   * Full-resolution signed URL. Present only on the `enhanced` side, and only
   * while `status === 'ready'` (issue #203): the enhanced result is a staged
   * object whose thumbnail derivative is best-effort, so a card renders
   * `thumbnailUrl ?? previewUrl`. Absent on `original`, which always has a real
   * thumbnail from the normal upload pipeline.
   */
  previewUrl?: string | null;
  width: number | null;
  height: number | null;
  size: string | null;
}

export interface EnhancementListItem {
  id: string;
  mediaItemId: string;
  status: EnhancementStatus;
  decision: ApplyDecision | null;
  model: string | null;
  params: EnhanceParams | null;
  original: EnhancementThumbInfo;
  /** All-null unless `status === 'ready'` — only a ready row still owns staged bytes. */
  enhanced: EnhancementThumbInfo;
  downscaled: boolean;
  /**
   * Server-computed reap deadline (ISO 8601). Non-null ONLY for `ready` and
   * `failed` — the two statuses the purge job actually collects. The client
   * renders its countdown from this and never from its own knowledge of the
   * `pictureEnhancement.retentionHours` setting.
   */
  expiresAt: string | null;
  lastError: string | null;
  resultMediaItemId: string | null;
  sourceFilename: string | null;
  capturedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnhancementListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface EnhancementListResponse {
  items: EnhancementListItem[];
  meta: EnhancementListMeta;
}

export interface ListEnhancementsParams {
  circleId: string;
  status?: EnhancementStatusFilter;
  page?: number;
  /** Server caps this at 50 (default 24). */
  pageSize?: number;
  sortBy?: EnhancementSortBy;
  sortOrder?: EnhancementSortOrder;
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

/**
 * Paginated, cross-item listing of a circle's enhancements — the data behind
 * the AI Enhancements hub. Only non-default params go on the wire so the
 * default view's request stays minimal.
 */
export async function listEnhancements(
  params: ListEnhancementsParams,
): Promise<EnhancementListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  if (params.sortBy) p.set('sortBy', params.sortBy);
  if (params.sortOrder) p.set('sortOrder', params.sortOrder);
  const result = await api.get<EnhancementListResponse>(
    `/media/enhancements?${p.toString()}`,
  );
  return { items: result.items ?? [], meta: result.meta };
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
