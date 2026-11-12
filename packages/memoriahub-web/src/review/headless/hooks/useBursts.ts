import { useState, useCallback, useRef } from 'react';
import {
  listBurstGroups,
  getBurstGroup,
  resolveBurstGroup,
  bulkResolveBurstGroups,
  bulkResolveBurstGroupsByThreshold,
  bulkDismissBurstGroupsByThreshold,
  fetchAllPendingBurstGroupIds,
  dismissBurstGroup,
} from '../services/bursts.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { SortOrder } from '../../../media/headless/index.js';
import type {
  BurstGroupStatus,
  BurstSortBy,
  BurstGroupSummary,
  BurstGroupDetail,
  BurstListMeta,
  BurstResolveResult,
  GroupResolveAction,
  GroupBulkResolveResult,
} from '../services/bursts.js';
import type { CreateReviewRunResponse } from '../../../review-runs/headless/index.js';

/**
 * The filters, sort and page of a burst group listing.
 *
 * @stability experimental
 */
export interface FetchBurstGroupsParams {
  circleId: string;
  status?: BurstGroupStatus;
  page?: number;
  sortBy?: BurstSortBy;
  sortOrder?: SortOrder;
}

/**
 * The state and actions {@link useBurstGroups} returns.
 *
 * @stability experimental
 */
export interface UseBurstGroupsResult {
  items: BurstGroupSummary[];
  meta: BurstListMeta | null;
  isLoading: boolean;
  error: string | null;
  /** Loads a page of groups. */
  fetchGroups: (params: FetchBurstGroupsParams) => Promise<void>;
  /** Resolves the selected groups, keeping each group's suggested best shot. */
  bulkResolve: (ids: string[], action: GroupResolveAction) => Promise<GroupBulkResolveResult>;
  /** Start an async review run resolving every pending group at/above `threshold`. */
  bulkResolveByThreshold: (
    threshold: number,
    action: GroupResolveAction,
  ) => Promise<CreateReviewRunResponse>;
  /** Start an async review run dismissing every pending group below `threshold`. */
  dismissByThreshold: (threshold: number) => Promise<CreateReviewRunResponse>;
  /** Collect the ids of every pending burst group in the active circle (cross-page). */
  fetchAllPendingIds: () => Promise<string[]>;
}

/**
 * Loads a page of burst groups and exposes the bulk resolve and dismiss actions of the review queue.
 *
 * @stability experimental
 */
export function useBurstGroups(): UseBurstGroupsResult {
  const [items, setItems] = useState<BurstGroupSummary[]>([]);
  const [meta, setMeta] = useState<BurstListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember the last fetch params so bulkResolve can refresh the same view.
  const lastParamsRef = useRef<FetchBurstGroupsParams | null>(null);
  const isMounted = useIsMounted();

  const fetchGroups = useCallback(async (params: FetchBurstGroupsParams) => {
    lastParamsRef.current = params;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listBurstGroups(params);
      if (!isMounted()) return;
      setItems(result.items);
      setMeta(result.meta);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load burst groups');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const bulkResolve = useCallback(
    async (ids: string[], action: GroupResolveAction) => {
      const circleId = lastParamsRef.current?.circleId;
      if (!circleId) {
        throw new Error('No active circle to resolve burst groups');
      }
      const result = await bulkResolveBurstGroups({ circleId, ids, action });
      if (lastParamsRef.current) {
        await fetchGroups(lastParamsRef.current);
      }
      return result;
    },
    [fetchGroups],
  );

  // Both threshold actions START A RUN and return immediately (issue #190).
  // There is deliberately no list refetch here: the work happens in the
  // background and the caller navigates to /review-runs/:runId, so refreshing
  // the list we are about to leave would only show a stale mid-run snapshot.
  const bulkResolveByThreshold = useCallback(
    async (threshold: number, action: GroupResolveAction) => {
      const circleId = lastParamsRef.current?.circleId;
      if (!circleId) {
        throw new Error('No active circle to resolve burst groups');
      }
      return bulkResolveBurstGroupsByThreshold({ circleId, threshold, action });
    },
    [],
  );

  const dismissByThreshold = useCallback(async (threshold: number) => {
    const circleId = lastParamsRef.current?.circleId;
    if (!circleId) {
      throw new Error('No active circle to dismiss burst groups');
    }
    return bulkDismissBurstGroupsByThreshold({ circleId, threshold });
  }, []);

  const fetchAllPendingIds = useCallback(async () => {
    const circleId = lastParamsRef.current?.circleId;
    if (!circleId) {
      throw new Error('No active circle to select burst groups');
    }
    return fetchAllPendingBurstGroupIds(circleId);
  }, []);

  return {
    items,
    meta,
    isLoading,
    error,
    fetchGroups,
    bulkResolve,
    bulkResolveByThreshold,
    dismissByThreshold,
    fetchAllPendingIds,
  };
}

/**
 * The state and actions {@link useBurstGroupDetail} returns.
 *
 * @stability experimental
 */
export interface UseBurstGroupDetailResult {
  group: BurstGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  /** Loads (or reloads) the group. */
  fetchGroup: (id: string) => Promise<void>;
  /** Keeps the chosen members and archives or trashes the rest. */
  resolve: (keepIds: string[], action: GroupResolveAction) => Promise<BurstResolveResult>;
  /** Marks the group as not a burst. */
  dismiss: () => Promise<void>;
  resolving: boolean;
  dismissing: boolean;
}

/**
 * Loads one burst group with its members and exposes resolve and dismiss.
 *
 * @stability experimental
 */
export function useBurstGroupDetail(groupId: string): UseBurstGroupDetailResult {
  const [group, setGroup] = useState<BurstGroupDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const isMounted = useIsMounted();

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getBurstGroup(id);
      if (!isMounted()) return;
      setGroup(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load burst group');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const resolve = useCallback(
    async (keepIds: string[], action: GroupResolveAction) => {
      setResolving(true);
      try {
        return await resolveBurstGroup(groupId, keepIds, action);
      } finally {
        if (isMounted()) setResolving(false);
      }
    },
    [groupId, isMounted],
  );

  const dismiss = useCallback(async () => {
    setDismissing(true);
    try {
      await dismissBurstGroup(groupId);
    } finally {
      if (isMounted()) setDismissing(false);
    }
  }, [groupId, isMounted]);

  return { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing };
}

