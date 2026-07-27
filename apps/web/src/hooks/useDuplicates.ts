import { useState, useCallback, useRef } from 'react';
import {
  listDuplicateGroups,
  getDuplicateGroup,
  resolveDuplicateGroup,
  bulkResolveDuplicateGroups,
  bulkResolveDuplicateGroupsByThreshold,
  bulkDismissDuplicateGroupsByThreshold,
  fetchAllPendingDuplicateGroupIds,
  dismissDuplicateGroup,
} from '../services/duplicates';
import { useIsMounted } from './useIsMounted';
import type { SortOrder } from '../types/media';
import type {
  DuplicateGroupStatus,
  DuplicateGroupKind,
  DuplicateSortBy,
  DuplicateGroupSummary,
  DuplicateGroupDetail,
  DuplicateListMeta,
  DuplicateResolveAction,
  DuplicateResolveResult,
  DuplicateDismissResult,
} from '../services/duplicates';
import type { GroupBulkResolveResult } from '../services/bursts';
import type { CreateReviewRunResponse } from '../types/reviewRuns';

export interface FetchDuplicateGroupsParams {
  circleId: string;
  status?: DuplicateGroupStatus;
  kind?: DuplicateGroupKind;
  page?: number;
  sortBy?: DuplicateSortBy;
  sortOrder?: SortOrder;
}

interface UseDuplicateGroupsResult {
  items: DuplicateGroupSummary[];
  meta: DuplicateListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: FetchDuplicateGroupsParams) => Promise<void>;
  bulkResolve: (ids: string[], action: DuplicateResolveAction) => Promise<GroupBulkResolveResult>;
  /** Start an async review run resolving every pending group at/above `threshold`. */
  bulkResolveByThreshold: (
    threshold: number,
    action: DuplicateResolveAction,
  ) => Promise<CreateReviewRunResponse>;
  /** Start an async review run dismissing every pending group below `threshold`. */
  dismissByThreshold: (threshold: number) => Promise<CreateReviewRunResponse>;
  /** Collect the ids of every pending duplicate group in the active circle (cross-page, respects the kind filter). */
  fetchAllPendingIds: () => Promise<string[]>;
}

export function useDuplicateGroups(): UseDuplicateGroupsResult {
  const [items, setItems] = useState<DuplicateGroupSummary[]>([]);
  const [meta, setMeta] = useState<DuplicateListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember the last fetch params so bulkResolve can refresh the same view.
  const lastParamsRef = useRef<FetchDuplicateGroupsParams | null>(null);
  const isMounted = useIsMounted();

  const fetchGroups = useCallback(async (params: FetchDuplicateGroupsParams) => {
    lastParamsRef.current = params;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listDuplicateGroups(params);
      if (!isMounted()) return;
      setItems(result.items);
      setMeta(result.meta);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load duplicate groups');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const bulkResolve = useCallback(
    async (ids: string[], action: DuplicateResolveAction) => {
      const circleId = lastParamsRef.current?.circleId;
      if (!circleId) {
        throw new Error('No active circle to resolve duplicate groups');
      }
      const result = await bulkResolveDuplicateGroups({ circleId, ids, action });
      if (lastParamsRef.current) {
        await fetchGroups(lastParamsRef.current);
      }
      return result;
    },
    [fetchGroups],
  );

  // Both threshold actions START A RUN and return immediately (issue #190).
  // No list refetch: the work happens in the background and the caller
  // navigates to /review-runs/:runId.
  const bulkResolveByThreshold = useCallback(
    async (threshold: number, action: DuplicateResolveAction) => {
      const circleId = lastParamsRef.current?.circleId;
      if (!circleId) {
        throw new Error('No active circle to resolve duplicate groups');
      }
      return bulkResolveDuplicateGroupsByThreshold({ circleId, threshold, action });
    },
    [],
  );

  const dismissByThreshold = useCallback(async (threshold: number) => {
    const circleId = lastParamsRef.current?.circleId;
    if (!circleId) {
      throw new Error('No active circle to dismiss duplicate groups');
    }
    return bulkDismissDuplicateGroupsByThreshold({ circleId, threshold });
  }, []);

  const fetchAllPendingIds = useCallback(async () => {
    const circleId = lastParamsRef.current?.circleId;
    if (!circleId) {
      throw new Error('No active circle to select duplicate groups');
    }
    return fetchAllPendingDuplicateGroupIds({ circleId, kind: lastParamsRef.current?.kind });
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

interface UseDuplicateGroupDetailResult {
  group: DuplicateGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchGroup: (id: string) => Promise<void>;
  resolve: (keepIds: string[], action: DuplicateResolveAction) => Promise<DuplicateResolveResult>;
  dismiss: () => Promise<DuplicateDismissResult>;
  resolving: boolean;
  dismissing: boolean;
}

export function useDuplicateGroupDetail(groupId: string): UseDuplicateGroupDetailResult {
  const [group, setGroup] = useState<DuplicateGroupDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const isMounted = useIsMounted();

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getDuplicateGroup(id);
      if (!isMounted()) return;
      setGroup(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load duplicate group');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const resolve = useCallback(
    async (keepIds: string[], action: DuplicateResolveAction) => {
      setResolving(true);
      try {
        return await resolveDuplicateGroup(groupId, keepIds, action);
      } finally {
        if (isMounted()) setResolving(false);
      }
    },
    [groupId, isMounted],
  );

  const dismiss = useCallback(async () => {
    setDismissing(true);
    try {
      return await dismissDuplicateGroup(groupId);
    } finally {
      if (isMounted()) setDismissing(false);
    }
  }, [groupId, isMounted]);

  return { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing };
}
