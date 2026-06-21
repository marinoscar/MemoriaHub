import { useState, useCallback } from 'react';
import {
  listSimilarGroups,
  getSimilarGroup,
  resolveSimilarGroup,
  dismissSimilarGroup,
  getCircleDedupSettings,
  updateCircleDedupSettings,
} from '../services/similar';
import type {
  SimilarGroupStatus,
  SimilarGroupSummary,
  SimilarGroupDetail,
  SimilarListMeta,
  CircleDedupSettings,
} from '../services/similar';

interface UseSimilarGroupsResult {
  items: SimilarGroupSummary[];
  meta: SimilarListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: { circleId: string; status?: SimilarGroupStatus; page?: number }) => Promise<void>;
}

export function useSimilarGroups(): UseSimilarGroupsResult {
  const [items, setItems] = useState<SimilarGroupSummary[]>([]);
  const [meta, setMeta] = useState<SimilarListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(async (params: { circleId: string; status?: SimilarGroupStatus; page?: number }) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listSimilarGroups(params);
      setItems(result.items);
      setMeta(result.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load similar photo groups');
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { items, meta, isLoading, error, fetchGroups };
}

interface UseSimilarGroupDetailResult {
  group: SimilarGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchGroup: (id: string) => Promise<void>;
  resolve: (keepIds: string[]) => Promise<{ deleted: number; kept: number }>;
  dismiss: () => Promise<void>;
  resolving: boolean;
  dismissing: boolean;
}

export function useSimilarGroupDetail(groupId: string): UseSimilarGroupDetailResult {
  const [group, setGroup] = useState<SimilarGroupDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getSimilarGroup(id);
      setGroup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load similar photo group');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resolve = useCallback(async (keepIds: string[]) => {
    setResolving(true);
    try {
      const result = await resolveSimilarGroup(groupId, keepIds);
      return { deleted: result.deleted, kept: result.kept };
    } finally {
      setResolving(false);
    }
  }, [groupId]);

  const dismiss = useCallback(async () => {
    setDismissing(true);
    try {
      await dismissSimilarGroup(groupId);
    } finally {
      setDismissing(false);
    }
  }, [groupId]);

  return { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing };
}

interface UseCircleDedupSettingsResult {
  settings: CircleDedupSettings | null;
  isLoading: boolean;
  error: string | null;
  toggling: boolean;
  fetchSettings: (circleId: string) => Promise<void>;
  toggle: (circleId: string, enabled: boolean) => Promise<void>;
}

export function useCircleDedupSettings(): UseCircleDedupSettingsResult {
  const [settings, setSettings] = useState<CircleDedupSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const fetchSettings = useCallback(async (circleId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getCircleDedupSettings(circleId);
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dedup settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const toggle = useCallback(async (circleId: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const result = await updateCircleDedupSettings(circleId, enabled);
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update visual dedup setting');
      throw err;
    } finally {
      setToggling(false);
    }
  }, []);

  return { settings, isLoading, error, toggling, fetchSettings, toggle };
}
