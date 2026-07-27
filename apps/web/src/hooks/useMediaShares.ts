import { useState, useCallback, useEffect } from 'react';
import type {
  MediaShare,
  ShareStatus,
  ShareTargetType,
  CreateShareRequest,
  UpdateShareRequest,
  BulkShareRequest,
} from '../types/sharing';
import {
  listShares,
  createShare as createShareApi,
  updateShare as updateShareApi,
  revokeShare as revokeShareApi,
  bulkShares as bulkSharesApi,
  type ShareListMeta,
} from '../services/shareService';
import { useIsMounted } from './useIsMounted';

// ---------------------------------------------------------------------------
// Hook params and return shape
// ---------------------------------------------------------------------------

interface UseMediaSharesParams {
  scope?: 'mine' | 'all';
  status?: ShareStatus;
  targetType?: ShareTargetType;
  page?: number;
  pageSize?: number;
}

interface UseMediaSharesResult {
  shares: MediaShare[];
  meta: ShareListMeta | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  createShare: (req: CreateShareRequest) => Promise<MediaShare>;
  updateShare: (id: string, req: UpdateShareRequest) => Promise<MediaShare>;
  revokeShare: (id: string) => Promise<void>;
  bulkAction: (req: BulkShareRequest) => Promise<{ affected: number }>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useMediaShares(params?: UseMediaSharesParams): UseMediaSharesResult {
  const [shares, setShares] = useState<MediaShare[]>([]);
  const [meta, setMeta] = useState<ShareListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listShares(params);
      if (!isMounted()) return;
      setShares(result.items);
      setMeta(result.meta);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch shares';
      setError(message);
      setShares([]);
      setMeta(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [
    params?.scope,
    params?.status,
    params?.targetType,
    params?.page,
    params?.pageSize,
    isMounted,
  ]);

  const createShare = useCallback(
    async (req: CreateShareRequest): Promise<MediaShare> => {
      setError(null);
      try {
        const share = await createShareApi(req);
        await refetch();
        return share;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create share';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [refetch, isMounted],
  );

  const updateShare = useCallback(
    async (id: string, req: UpdateShareRequest): Promise<MediaShare> => {
      setError(null);
      try {
        const updated = await updateShareApi(id, req);
        await refetch();
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update share';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [refetch, isMounted],
  );

  const revokeShare = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        await revokeShareApi(id);
        await refetch();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to revoke share';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [refetch, isMounted],
  );

  const bulkAction = useCallback(
    async (req: BulkShareRequest): Promise<{ affected: number }> => {
      setError(null);
      try {
        const result = await bulkSharesApi(req);
        await refetch();
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to perform bulk action';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [refetch, isMounted],
  );

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    shares,
    meta,
    isLoading,
    error,
    refetch,
    createShare,
    updateShare,
    revokeShare,
    bulkAction,
  };
}
