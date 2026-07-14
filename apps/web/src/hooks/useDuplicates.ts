import { useState, useCallback, useRef } from 'react';
import {
  listDuplicateGroups,
  getDuplicateGroup,
  resolveDuplicateGroup,
  bulkResolveDuplicateGroups,
  bulkResolveDuplicateGroupsByThreshold,
  dismissDuplicateGroup,
} from '../services/duplicates';
import type {
  DuplicateGroupStatus,
  DuplicateGroupKind,
  DuplicateGroupSummary,
  DuplicateGroupDetail,
  DuplicateListMeta,
  DuplicateResolveAction,
  DuplicateResolveResult,
  DuplicateDismissResult,
} from '../services/duplicates';
import type { GroupBulkResolveResult } from '../services/bursts';

interface FetchDuplicateGroupsParams {
  circleId: string;
  status?: DuplicateGroupStatus;
  kind?: DuplicateGroupKind;
  page?: number;
}

interface UseDuplicateGroupsResult {
  items: DuplicateGroupSummary[];
  meta: DuplicateListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: FetchDuplicateGroupsParams) => Promise<void>;
  bulkResolve: (ids: string[], action: DuplicateResolveAction) => Promise<GroupBulkResolveResult>;
  bulkResolveByThreshold: (
    threshold: number,
    action: DuplicateResolveAction,
  ) => Promise<GroupBulkResolveResult>;
}

export function useDuplicateGroups(): UseDuplicateGroupsResult {
  const [items, setItems] = useState<DuplicateGroupSummary[]>([]);
  const [meta, setMeta] = useState<DuplicateListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember the last fetch params so bulkResolve can refresh the same view.
  const lastParamsRef = useRef<FetchDuplicateGroupsParams | null>(null);

  const fetchGroups = useCallback(async (params: FetchDuplicateGroupsParams) => {
    lastParamsRef.current = params;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listDuplicateGroups(params);
      setItems(result.items);
      setMeta(result.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load duplicate groups');
    } finally {
      setIsLoading(false);
    }
  }, []);

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

  const bulkResolveByThreshold = useCallback(
    async (threshold: number, action: DuplicateResolveAction) => {
      const circleId = lastParamsRef.current?.circleId;
      if (!circleId) {
        throw new Error('No active circle to resolve duplicate groups');
      }
      const result = await bulkResolveDuplicateGroupsByThreshold({ circleId, threshold, action });
      if (lastParamsRef.current) {
        await fetchGroups(lastParamsRef.current);
      }
      return result;
    },
    [fetchGroups],
  );

  return { items, meta, isLoading, error, fetchGroups, bulkResolve, bulkResolveByThreshold };
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

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getDuplicateGroup(id);
      setGroup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load duplicate group');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resolve = useCallback(
    async (keepIds: string[], action: DuplicateResolveAction) => {
      setResolving(true);
      try {
        return await resolveDuplicateGroup(groupId, keepIds, action);
      } finally {
        setResolving(false);
      }
    },
    [groupId],
  );

  const dismiss = useCallback(async () => {
    setDismissing(true);
    try {
      return await dismissDuplicateGroup(groupId);
    } finally {
      setDismissing(false);
    }
  }, [groupId]);

  return { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing };
}
