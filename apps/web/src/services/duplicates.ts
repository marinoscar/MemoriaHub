import { api } from './api';
import { BULK_RESOLVE_CHUNK_SIZE } from './bursts';
import type { GroupBulkResolveResult } from './bursts';

/** Max page size the list endpoint accepts; used when collecting all ids. */
const LIST_MAX_PAGE_SIZE = 100;

export type DuplicateGroupStatus = 'pending' | 'resolved' | 'dismissed';
export type DuplicateGroupKind = 'exact_variant' | 'edited' | 'similar';
export type DuplicateResolveAction = 'archive' | 'trash';

export interface DuplicateGroupSummary {
  id: string;
  status: DuplicateGroupStatus;
  kind: DuplicateGroupKind;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number;
  suggestedBestItemId: string | null;
  coverThumbnailUrls: string[];
}

export interface DuplicateListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface DuplicateListResponse {
  items: DuplicateGroupSummary[];
  meta: DuplicateListMeta;
}

export interface DuplicateGroupMember {
  id: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  capturedAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  hasGps: boolean;
  contentHash: string | null;
  sharpnessScore: number | null;
  qualityScore: number | null;
  similarityToBest: number | null;
  isSuggestedBest: boolean;
}

export interface DuplicateGroupDetail {
  id: string;
  circleId: string;
  status: DuplicateGroupStatus;
  kind: DuplicateGroupKind;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: DuplicateGroupMember[];
}

export interface DuplicateResolveResult {
  removed: number;
  kept: number;
  action: DuplicateResolveAction;
  groupStatus: DuplicateGroupStatus;
}

export interface DuplicateDismissResult {
  groupStatus: DuplicateGroupStatus;
  ungrouped: number;
}

export interface DuplicateRerunResult {
  jobId: string;
  status: string;
}

/**
 * Result of a threshold-based duplicate bulk resolve. The endpoint returns
 * `hasMore` (there may be more eligible groups beyond this batch); callers
 * auto-loop while `hasMore === true`.
 */
export interface DuplicateBulkResolveByThresholdResult extends GroupBulkResolveResult {
  hasMore: boolean;
}

export async function listDuplicateGroups(params: {
  circleId: string;
  status?: DuplicateGroupStatus;
  kind?: DuplicateGroupKind;
  page?: number;
  pageSize?: number;
}): Promise<DuplicateListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.kind) p.set('kind', params.kind);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<DuplicateListResponse>(`/media/duplicates?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

export async function getDuplicateGroup(id: string): Promise<DuplicateGroupDetail> {
  return api.get<DuplicateGroupDetail>(`/media/duplicates/${id}`);
}

export async function resolveDuplicateGroup(
  id: string,
  keepIds: string[],
  action: DuplicateResolveAction,
): Promise<DuplicateResolveResult> {
  return api.post<DuplicateResolveResult>(`/media/duplicates/${id}/resolve`, { keepIds, action });
}

/** Empty aggregate used as the seed when summing per-chunk results. */
function emptyBulkResult(action: DuplicateResolveAction): GroupBulkResolveResult {
  return { resolvedGroups: 0, keptCount: 0, removedCount: 0, action, skipped: 0, errors: 0 };
}

/** Fold a per-chunk result into a running aggregate. */
function mergeBulkResult(
  acc: GroupBulkResolveResult,
  next: GroupBulkResolveResult,
): GroupBulkResolveResult {
  return {
    resolvedGroups: acc.resolvedGroups + next.resolvedGroups,
    keptCount: acc.keptCount + next.keptCount,
    removedCount: acc.removedCount + next.removedCount,
    action: next.action,
    skipped: acc.skipped + next.skipped,
    errors: acc.errors + next.errors,
  };
}

/**
 * Resolve explicit duplicate-group ids in bulk. The backend caps a single
 * request at {@link BULK_RESOLVE_CHUNK_SIZE} ids, so larger selections are split
 * into sequential chunks and their results aggregated into one summed result
 * whose shape matches a single-call response.
 */
export async function bulkResolveDuplicateGroups(params: {
  circleId: string;
  ids: string[];
  action: DuplicateResolveAction;
}): Promise<GroupBulkResolveResult> {
  const { circleId, ids, action } = params;
  let aggregate = emptyBulkResult(action);
  for (let i = 0; i < ids.length; i += BULK_RESOLVE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BULK_RESOLVE_CHUNK_SIZE);
    const result = await api.post<GroupBulkResolveResult>('/media/duplicates/bulk/resolve', {
      circleId,
      ids: chunk,
      action,
    });
    aggregate = mergeBulkResult(aggregate, result);
  }
  return aggregate;
}

export async function bulkResolveDuplicateGroupsByThreshold(params: {
  circleId: string;
  threshold: number;
  action: DuplicateResolveAction;
}): Promise<DuplicateBulkResolveByThresholdResult> {
  return api.post<DuplicateBulkResolveByThresholdResult>(
    '/media/duplicates/bulk/resolve-by-threshold',
    params,
  );
}

/**
 * Collect the ids of every pending duplicate group in a circle (optionally
 * filtered by kind) by paginating the list endpoint at the maximum page size.
 * Used for true cross-page "select all".
 */
export async function fetchAllPendingDuplicateGroupIds(params: {
  circleId: string;
  kind?: DuplicateGroupKind;
}): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  for (let guard = 0; guard < 1000; guard += 1) {
    const { items, meta } = await listDuplicateGroups({
      circleId: params.circleId,
      status: 'pending',
      kind: params.kind,
      page,
      pageSize: LIST_MAX_PAGE_SIZE,
    });
    ids.push(...items.map((g) => g.id));
    const totalPages = meta ? Math.ceil(meta.total / meta.pageSize) : page;
    if (page >= totalPages || items.length === 0) break;
    page += 1;
  }
  return ids;
}

export async function dismissDuplicateGroup(id: string): Promise<DuplicateDismissResult> {
  return api.post<DuplicateDismissResult>(`/media/duplicates/${id}/dismiss`);
}

export async function rerunDuplicateDetection(mediaItemId: string): Promise<DuplicateRerunResult> {
  return api.post<DuplicateRerunResult>(`/media/${mediaItemId}/duplicates/rerun`);
}
