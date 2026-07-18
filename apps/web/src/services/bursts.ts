import { api } from './api';

/**
 * Maximum number of group ids accepted by a single explicit-id bulk-resolve
 * request. Enforced server-side by the DTO's `@Max(100)`. Larger selections are
 * split into sequential chunks and their results aggregated (see
 * `bulkResolveBurstGroups`).
 */
export const BULK_RESOLVE_CHUNK_SIZE = 100;

/** Max page size the list endpoint accepts; used when collecting all ids. */
const LIST_MAX_PAGE_SIZE = 100;

export type BurstGroupStatus = 'pending' | 'resolved' | 'dismissed';

/** Archive-or-trash action shared by burst and duplicate group resolution. */
export type GroupResolveAction = 'archive' | 'trash';

export interface BurstGroupSummary {
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  suggestedBestThumbnailUrl: string | null;
  coverThumbnailUrls: string[];
  createdAt: string;
}

export interface BurstListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface BurstListResponse {
  items: BurstGroupSummary[];
  meta: BurstListMeta;
}

export interface BurstGroupMember {
  id: string;
  capturedAt: string | null;
  burstScore: number | null;
  sharpnessScore: number | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  isSuggestedBest: boolean;
}

export interface BurstGroupDetail {
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: BurstGroupMember[];
}

export interface BurstResolveResult {
  removed: number;
  kept: number;
  action: GroupResolveAction;
  groupStatus: BurstGroupStatus;
}

export interface BurstDismissResult {
  groupStatus: BurstGroupStatus;
  ungrouped: number;
}

/** Result of a bulk resolve across many groups (shared shape with duplicates). */
export interface GroupBulkResolveResult {
  resolvedGroups: number;
  keptCount: number;
  removedCount: number;
  action: GroupResolveAction;
  skipped: number;
  errors: string[];
}

/**
 * Result of a threshold-based bulk resolve. The burst endpoint returns
 * `remaining` (exact count of still-pending eligible groups after this batch);
 * callers auto-loop while `remaining > 0`.
 */
export interface GroupBulkResolveByThresholdResult extends GroupBulkResolveResult {
  remaining: number;
}

export async function listBurstGroups(params: {
  circleId: string;
  status?: BurstGroupStatus;
  page?: number;
  pageSize?: number;
}): Promise<BurstListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<{ items: BurstGroupSummary[]; meta: BurstListMeta }>(`/media/bursts?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

export async function getBurstGroup(id: string): Promise<BurstGroupDetail> {
  return api.get<BurstGroupDetail>(`/media/bursts/${id}`);
}

export async function resolveBurstGroup(
  id: string,
  keepIds: string[],
  action: GroupResolveAction,
): Promise<BurstResolveResult> {
  return api.post<BurstResolveResult>(`/media/bursts/${id}/resolve`, { keepIds, action });
}

/** Empty aggregate used as the seed when summing per-chunk results. */
function emptyBulkResult(action: GroupResolveAction): GroupBulkResolveResult {
  return { resolvedGroups: 0, keptCount: 0, removedCount: 0, action, skipped: 0, errors: [] };
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
    errors: [...acc.errors, ...next.errors],
  };
}

/**
 * Resolve explicit burst-group ids in bulk. The backend caps a single request
 * at {@link BULK_RESOLVE_CHUNK_SIZE} ids, so larger selections are split into
 * sequential chunks and their results aggregated into one summed result whose
 * shape matches a single-call response.
 */
export async function bulkResolveBurstGroups(params: {
  circleId: string;
  ids: string[];
  action: GroupResolveAction;
}): Promise<GroupBulkResolveResult> {
  const { circleId, ids, action } = params;
  let aggregate = emptyBulkResult(action);
  for (let i = 0; i < ids.length; i += BULK_RESOLVE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BULK_RESOLVE_CHUNK_SIZE);
    const result = await api.post<GroupBulkResolveResult>('/media/bursts/bulk/resolve', {
      circleId,
      ids: chunk,
      action,
    });
    aggregate = mergeBulkResult(aggregate, result);
  }
  return aggregate;
}

export async function bulkResolveBurstGroupsByThreshold(params: {
  circleId: string;
  threshold: number;
  action: GroupResolveAction;
}): Promise<GroupBulkResolveByThresholdResult> {
  return api.post<GroupBulkResolveByThresholdResult>('/media/bursts/bulk/resolve-by-threshold', params);
}

/**
 * Collect the ids of every pending burst group in a circle by paginating the
 * list endpoint at the maximum page size. Used for true cross-page "select all".
 */
export async function fetchAllPendingBurstGroupIds(circleId: string): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  // Hard safety ceiling to avoid an unbounded loop if `meta` is malformed.
  for (let guard = 0; guard < 1000; guard += 1) {
    const { items, meta } = await listBurstGroups({
      circleId,
      status: 'pending',
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

export async function dismissBurstGroup(id: string): Promise<BurstDismissResult> {
  return api.post<BurstDismissResult>(`/media/bursts/${id}/dismiss`);
}
