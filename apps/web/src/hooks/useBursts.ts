import { useState, useCallback } from 'react';
import {
  listBurstGroups,
  getBurstGroup,
  resolveBurstGroup,
  dismissBurstGroup,
  getCircleBurstSettings,
  updateCircleBurstSettings,
} from '../services/bursts';
import type {
  BurstGroupStatus,
  BurstGroupSummary,
  BurstGroupDetail,
  BurstListMeta,
  CircleBurstSettings,
} from '../services/bursts';

interface UseBurstGroupsResult {
  items: BurstGroupSummary[];
  meta: BurstListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchGroups: (params: { circleId: string; status?: BurstGroupStatus; page?: number }) => Promise<void>;
}

export function useBurstGroups(): UseBurstGroupsResult {
  const [items, setItems] = useState<BurstGroupSummary[]>([]);
  const [meta, setMeta] = useState<BurstListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(async (params: { circleId: string; status?: BurstGroupStatus; page?: number }) => {
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

  return { items, meta, isLoading, error, fetchGroups };
}

interface UseBurstGroupDetailResult {
  group: BurstGroupDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchGroup: (id: string) => Promise<void>;
  resolve: (keepIds: string[]) => Promise<{ deleted: number; kept: number }>;
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

  const resolve = useCallback(async (keepIds: string[]) => {
    setResolving(true);
    try {
      const result = await resolveBurstGroup(groupId, keepIds);
      return { deleted: result.deleted, kept: result.kept };
    } finally {
      setResolving(false);
    }
  }, [groupId]);

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

interface UseCircleBurstSettingsResult {
  settings: CircleBurstSettings | null;
  isLoading: boolean;
  error: string | null;
  toggling: boolean;
  fetchSettings: (circleId: string) => Promise<void>;
  toggle: (circleId: string, enabled: boolean) => Promise<void>;
}

export function useCircleBurstSettings(): UseCircleBurstSettingsResult {
  const [settings, setSettings] = useState<CircleBurstSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const fetchSettings = useCallback(async (circleId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getCircleBurstSettings(circleId);
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load burst settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const toggle = useCallback(async (circleId: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const result = await updateCircleBurstSettings(circleId, enabled);
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update burst settings');
      throw err;
    } finally {
      setToggling(false);
    }
  }, []);

  return { settings, isLoading, error, toggling, fetchSettings, toggle };
}
