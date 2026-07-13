import { useState, useCallback, useRef } from 'react';
import {
  listBurstGroups,
  getBurstGroup,
  resolveBurstGroup,
  bulkResolveBurstGroups,
  dismissBurstGroup,
} from '../services/bursts';
import type {
  BurstGroupStatus,
  BurstGroupSummary,
  BurstGroupDetail,
  BurstListMeta,
  BurstResolveResult,
  GroupResolveAction,
  GroupBulkResolveResult,
} from '../services/bursts';

interface FetchBurstGroupsParams {
  circleId: string;
  status?: BurstGroupStatus;
  page?: number;
}

interface UseBurstGroupsResult {
  items: BurstGroupSummary[];
  meta: BurstListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: FetchBurstGroupsParams) => Promise<void>;
  bulkResolve: (ids: string[], action: GroupResolveAction) => Promise<GroupBulkResolveResult>;
}

export function useBurstGroups(): UseBurstGroupsResult {
  const [items, setItems] = useState<BurstGroupSummary[]>([]);
  const [meta, setMeta] = useState<BurstListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember the last fetch params so bulkResolve can refresh the same view.
  const lastParamsRef = useRef<FetchBurstGroupsParams | null>(null);

  const fetchGroups = useCallback(async (params: FetchBurstGroupsParams) => {
    lastParamsRef.current = params;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listBurstGroups(params);
      setItems(result.items);
      setMeta(result.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load burst groups');
    } finally {
      setIsLoading(false);
    }
  }, []);

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

  return { items, meta, isLoading, error, fetchGroups, bulkResolve };
}

interface UseBurstGroupDetailResult {
  group: BurstGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchGroup: (id: string) => Promise<void>;
  resolve: (keepIds: string[], action: GroupResolveAction) => Promise<BurstResolveResult>;
  dismiss: () => Promise<void>;
  resolving: boolean;
  dismissing: boolean;
}

export function useBurstGroupDetail(groupId: string): UseBurstGroupDetailResult {
  const [group, setGroup] = useState<BurstGroupDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getBurstGroup(id);
      setGroup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load burst group');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resolve = useCallback(
    async (keepIds: string[], action: GroupResolveAction) => {
      setResolving(true);
      try {
        return await resolveBurstGroup(groupId, keepIds, action);
      } finally {
        setResolving(false);
      }
    },
    [groupId],
  );

  const dismiss = useCallback(async () => {
    setDismissing(true);
    try {
      await dismissBurstGroup(groupId);
    } finally {
      setDismissing(false);
    }
  }, [groupId]);

  return { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing };
}

