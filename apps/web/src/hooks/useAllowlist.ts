import { useState, useCallback } from 'react';
import type { AllowedEmailEntry, AllowlistResponse } from '../types';
import {
  getAllowlist as fetchAllowlistApi,
  addToAllowlist as addToAllowlistApi,
  removeFromAllowlist as removeFromAllowlistApi,
} from '../services/api';

interface UseAllowlistResult {
  entries: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  error: string | null;
  fetchAllowlist: (params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: 'all' | 'pending' | 'claimed';
  }) => Promise<void>;
  addEmail: (email: string, notes?: string) => Promise<void>;
  removeEmail: (id: string) => Promise<void>;
}

export function useAllowlist(): UseAllowlistResult {
  const [entries, setEntries] = useState<AllowedEmailEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAllowlist = useCallback(
    async (params?: {
      page?: number;
      pageSize?: number;
      search?: string;
      status?: 'all' | 'pending' | 'claimed';
    }) => {
      setIsLoading(true);
      setError(null);
      try {
        const response: AllowlistResponse = await fetchAllowlistApi(params);
        setEntries(response.items);
        setTotal(response.total);
        setPage(response.page);
        setPageSize(response.pageSize);
        setTotalPages(response.totalPages);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch allowlist';
        setError(message);
        setEntries([]);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const addEmail = useCallback(
    async (email: string, notes?: string) => {
      setError(null);
      try {
        await addToAllowlistApi(email, notes);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add email';
        setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize],
  );

  const removeEmail = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await removeFromAllowlistApi(id);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove email';
        setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize],
  );

  return {
    entries,
    total,
    page,
    pageSize,
    totalPages,
    isLoading,
    error,
    fetchAllowlist,
    addEmail,
    removeEmail,
  };
}
