import type {
  ApplyEnhancement,
  EnhanceParams,
  EnhancementStatus as ContractEnhancementStatus,
} from '@marinoscar/memoriahub-contract/enhancement';
import { api, MemoriahubApiError as ApiError } from '../../../core/headless/index.js';
import type { BaseRun } from '../../../review-runs/headless/index.js';
import type { BulkEnhanceSkipped } from '../../../media/headless/index.js';

// ---------------------------------------------------------------------------
// Types — AI Picture Enhancer (see docs/specs/picture-enhancer.md §4.1, §8)
// ---------------------------------------------------------------------------

// The enhance request shape is `enhanceParamsSchema` of
// `@marinoscar/memoriahub-contract/enhancement`, shared with the API.
export type { EnhanceParams };

/**
 * What an enhancement should do to the photo (restore, brighten, colorize, polish or auto).
 *
 * @stability experimental
 */
export type EnhanceIntent = NonNullable<EnhanceParams['intent']>;
/**
 * How aggressive the correction is: subtle, balanced or strong.
 *
 * @stability experimental
 */
export type EnhanceStrength = NonNullable<EnhanceParams['strength']>;
/**
 * What the user decides about a ready result: keep both copies or replace the original.
 *
 * @stability experimental
 */
export type ApplyDecision = ApplyEnhancement['decision'];

/**
 * Task-specific preset. ORTHOGONAL to `intent` — a preset steers WHAT kind of
 * photo problem is being solved, while `intent`/`adjustments`/`instructions`
 * still steer the individual corrections. See the API's `enhance-prompt.builder`.
 *
 * @stability experimental
 */
export type EnhancePreset = NonNullable<EnhanceParams['preset']>;

/**
 * Per-run override of the `pictureEnhancement.defaultQuality` system setting.
 *
 * @stability experimental
 */
export type EnhanceQuality = NonNullable<EnhanceParams['quality']>;

// The concrete status vocabulary is the contract's (includes `cancelled`, a row
// withdrawn before any render ran, e.g. by a batch cancel).
/**
 * The lifecycle status of one enhancement (pending, processing, ready, failed, applied, discarded, expired or cancelled).
 *
 * @stability experimental
 */
export type EnhancementStatus = ContractEnhancementStatus;

/**
 * The individual adjustments an enhancement request can switch on.
 *
 * @stability experimental
 */
export type EnhanceAdjustments = NonNullable<EnhanceParams['adjustments']>;

/**
 * Image descriptor in the compare payload. Note: `size` is a STRING (bytes)
 * because the backend serializes BigInt-safe byte counts as strings.
 *
 * @stability experimental
 */
export interface EnhanceImageInfo {
  url: string | null;
  width: number | null;
  height: number | null;
  size: string | null;
}

/**
 * One enhancement with the compare payload: the original and enhanced images, the downscale flag and the request parameters.
 *
 * @stability experimental
 */
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

/**
 * What starting a single-photo enhancement returns: the enhancement and its job.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
 */
export type EnhancementStatusFilter =
  | EnhancementStatus
  | 'in_progress'
  | 'awaiting_decision'
  | 'terminal';

/**
 * Columns the list endpoint can order by (server default: `createdAt`).
 *
 * @stability experimental
 */
export type EnhancementSortBy = 'createdAt' | 'updatedAt';
/**
 * The sort order of the enhancement listing.
 *
 * @stability experimental
 */
export type EnhancementSortOrder = 'asc' | 'desc';

/**
 * Image descriptor in a LIST row. Deliberately NOT `EnhanceImageInfo`: the list
 * endpoint returns a signed *thumbnail* URL (`thumbnailUrl`) suited to a grid,
 * where the single-item compare payload returns a full-resolution `url`. Same
 * BigInt-as-string caveat applies to `size`.
 *
 * @stability experimental
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

/**
 * One row of the circle enhancement listing.
 *
 * @stability experimental
 */
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

/**
 * The pagination envelope of the enhancement listing.
 *
 * @stability experimental
 */
export interface EnhancementListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * One page of the circle enhancements.
 *
 * @stability experimental
 */
export interface EnhancementListResponse {
  items: EnhancementListItem[];
  meta: EnhancementListMeta;
}

/**
 * The filters, sort and page of the enhancement listing.
 *
 * @stability experimental
 */
export interface ListEnhancementsParams {
  circleId: string;
  status?: EnhancementStatusFilter;
  /**
   * Narrow the listing to one bulk-enhance batch (epic #420, issue #421).
   * Composes with `status` — e.g. a batch's failed rows only.
   */
  batchId?: string;
  page?: number;
  /** Server caps this at 50 (default 24). */
  pageSize?: number;
  sortBy?: EnhancementSortBy;
  sortOrder?: EnhancementSortOrder;
}

// ---------------------------------------------------------------------------
// Types — bulk-enhancement batches (epic #420, issue #421)
// GET /api/enhancement-batches[/:id], POST /api/enhancement-batches/:id/cancel
// ---------------------------------------------------------------------------

/**
 * A bulk-enhance batch's progress payload.
 *
 * Deliberately extends {@link BaseRun}: the API serializes a batch with exactly
 * the shared async-run field set (the same one trash-empty, workflow and review
 * runs use), so `RunProgressPanel` and `useRunPolling` drive it unchanged and
 * this phase needed no new progress component. The extras below are the
 * batch-specific fields that sit OUTSIDE that contract.
 *
 * Counter semantics worth remembering (all derived live from the batch's
 * enhancement rows — a batch stores no counter columns):
 *  - `succeededCount` counts every row whose render COMPLETED (ready, applied,
 *    discarded, expired) — not "finished with", so a `ready` row is counted
 *    while it still needs a human decision.
 *  - `skippedCount` counts rows a cancel withdrew before any render ran.
 *
 * @stability experimental
 */
export interface EnhancementBatch extends BaseRun {
  /** Ids submitted to `POST /media/bulk/enhance`. */
  requestedCount: number;
  /** Of those, how many were actually queued at submit time. */
  queuedCount: number;
  /** Per-reason breakdown of the submit-time ineligibles; null for old rows. */
  skipped: BulkEnhanceSkipped | null;
  /** The one params object applied to every photo in the batch. */
  params: EnhanceParams;
  /** How the batch was started (currently always the bulk endpoint). */
  source: string;
  cancelledAt: string | null;
}

/**
 * One page of the circle bulk enhancement batches.
 *
 * @stability experimental
 */
export interface EnhancementBatchListResponse {
  items: EnhancementBatch[];
  meta: EnhancementListMeta;
}

/**
 * The page parameters of the batch listing.
 *
 * @stability experimental
 */
export interface ListEnhancementBatchesParams {
  circleId: string;
  page?: number;
  /** Server caps this at 50 (default 20). */
  pageSize?: number;
}

/**
 * `cancelled` is the number of still-queued enhancements withdrawn.
 *
 * @stability experimental
 */
export interface CancelEnhancementBatchResult {
  batchId: string;
  status: EnhancementBatch['status'];
  cancelled: number;
}

/**
 * Response of the apply endpoint. `replace` returns `{ status, width, height }`;
 * `keep_both` returns the newly-created media item (id/mediaItemId). Kept loose
 * so a single caller can handle both decisions.
 *
 * @stability experimental
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
 * (`GET /api/admin/memoriahub-ai/enhance/status`; RETRO-E4 moved it off the AI slice's prefix). `ready` is true only when the feature
 * toggle is on AND a model is selected AND an enabled credential exists for the
 * resolved provider — the same three conditions the enhance endpoint enforces.
 *
 * @stability experimental
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

/**
 * Admin: feature/provider readiness for the AI Picture Enhancer.
 *
 * @stability experimental
 */
export async function getEnhancerAdminStatus(): Promise<EnhancerAdminStatus> {
  return api.get<EnhancerAdminStatus>('/admin/memoriahub-ai/enhance/status');
}

/**
 * Paginated, cross-item listing of a circle's enhancements — the data behind
 * the AI Enhancements hub. Only non-default params go on the wire so the
 * default view's request stays minimal.
 *
 * @stability experimental
 */
export async function listEnhancements(
  params: ListEnhancementsParams,
): Promise<EnhancementListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.batchId) p.set('batchId', params.batchId);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  if (params.sortBy) p.set('sortBy', params.sortBy);
  if (params.sortOrder) p.set('sortOrder', params.sortOrder);
  const result = await api.get<EnhancementListResponse>(
    `/media/enhancements?${p.toString()}`,
  );
  return { items: result.items ?? [], meta: result.meta };
}

/**
 * Start an enhancement job. An empty params object requests full auto defaults.
 *
 * @stability experimental
 */
export async function startEnhance(
  id: string,
  params: EnhanceParams = {},
): Promise<StartEnhanceResult> {
  return api.post<StartEnhanceResult>(`/media/${id}/enhance`, params);
}

/**
 * Poll a single enhancement's status + compare payload.
 *
 * @stability experimental
 */
export async function getEnhancement(
  id: string,
  enhancementId: string,
): Promise<EnhancementDto> {
  return api.get<EnhancementDto>(`/media/${id}/enhance/${enhancementId}`);
}

/**
 * Fetch the latest enhancement for an item (to resume a review after reload).
 *
 * @stability experimental
 */
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

/**
 * Commit the result: create a new item (keep_both) or overwrite the original
 * (replace).
 *
 * `acknowledgeDownscale` passes the `blockReplaceOnDownscale` guard (issue
 * #426). Send it ONLY from behind an explicit confirmation that names the
 * resolution loss — it is informed consent, not a default. It has no effect on
 * `allowReplace: false`, which stays an absolute block.
 *
 * @stability experimental
 */
export async function applyEnhancement(
  id: string,
  enhancementId: string,
  decision: ApplyDecision,
  options: { acknowledgeDownscale?: boolean } = {},
): Promise<ApplyEnhancementResult> {
  return api.post<ApplyEnhancementResult>(
    `/media/${id}/enhance/${enhancementId}/apply`,
    {
      decision,
      ...(options.acknowledgeDownscale ? { acknowledgeDownscale: true } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Bulk-enhancement batches (epic #420, issue #423)
// ---------------------------------------------------------------------------

/**
 * A single batch's progress payload — polled while the batch is non-terminal.
 *
 * @stability experimental
 */
export async function getEnhancementBatch(batchId: string): Promise<EnhancementBatch> {
  return api.get<EnhancementBatch>(`/enhancement-batches/${batchId}`);
}

/**
 * A circle's batches, newest first. Backs the hub's "Recent batches" list.
 *
 * @stability experimental
 */
export async function listEnhancementBatches(
  params: ListEnhancementBatchesParams,
): Promise<EnhancementBatchListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<EnhancementBatchListResponse>(
    `/enhancement-batches?${p.toString()}`,
  );
  return { items: result.items ?? [], meta: result.meta };
}

/**
 * Withdraw a batch's still-QUEUED enhancements (collaborator).
 *
 * Deliberately not "stop the batch": an enhancement already processing is left
 * to finish, because its model call is already billed and aborting would spend
 * the money and throw the result away. 400 when the batch already finished —
 * surface the server's message rather than a generic one.
 *
 * @stability experimental
 */
export async function cancelEnhancementBatch(
  batchId: string,
): Promise<CancelEnhancementBatchResult> {
  return api.post<CancelEnhancementBatchResult>(`/enhancement-batches/${batchId}/cancel`);
}

/**
 * Discard the staging preview (204).
 *
 * @stability experimental
 */
export async function discardEnhancement(
  id: string,
  enhancementId: string,
): Promise<void> {
  await api.post<void>(`/media/${id}/enhance/${enhancementId}/discard`);
}
