import { useState, useCallback } from 'react';
import {
  listDuplicateGroups,
  getDuplicateGroup,
  resolveDuplicateGroup,
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

interface UseDuplicateGroupsResult {
  items: DuplicateGroupSummary[];
  meta: DuplicateListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: {
    circleId: string;
    status?: DuplicateGroupStatus;
    kind?: DuplicateGroupKind;
    page?: number;
  }) => Promise<void>;
}

export function useDuplicateGroups(): UseDuplicateGroupsResult {
  const [items, setItems] = useState<DuplicateGroupSummary[]>([]);
  const [meta, setMeta] = useState<DuplicateListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(
    async (params: {
      circleId: string;
      status?: DuplicateGroupStatus;
      kind?: DuplicateGroupKind;
      page?: number;
    }) => {
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
    },
    [],
  );

  return { items, meta, isLoading, error, fetchGroups };
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
