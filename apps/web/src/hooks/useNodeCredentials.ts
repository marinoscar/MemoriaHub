import { useState, useCallback, useEffect } from 'react';
import {
  getNodeCredentials,
  createNodeCredential as createNodeCredentialService,
  revokeNodeCredential as revokeNodeCredentialService,
} from '../services/workers';
import { useIsMounted } from './useIsMounted';
import type { AdminNodeCredentialDto, CreatedNodeCredentialDto } from '../services/workers';

export interface UseNodeCredentialsResult {
  credentials: AdminNodeCredentialDto[];
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  createCredential: (body: {
    name: string;
    expiresAt: string | null;
  }) => Promise<CreatedNodeCredentialDto>;
  revokeCredential: (id: string) => Promise<void>;
}

export function useNodeCredentials(): UseNodeCredentialsResult {
  const [credentials, setCredentials] = useState<AdminNodeCredentialDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  // Silent fetch (no loading spinner toggling on repeated calls).
  const fetchCredentials = useCallback(async () => {
    try {
      const data = await getNodeCredentials();
      if (!isMounted()) return;
      setCredentials(data);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load node credentials');
    }
  }, [isMounted]);

  // Explicit refresh with a loading indicator.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchCredentials();
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [fetchCredentials, isMounted]);

  // Initial load.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createCredential = useCallback(
    async (body: { name: string; expiresAt: string | null }) => {
      const created = await createNodeCredentialService(body);
      await fetchCredentials();
      return created;
    },
    [fetchCredentials],
  );

  const revokeCredential = useCallback(
    async (id: string) => {
      await revokeNodeCredentialService(id);
      await fetchCredentials();
    },
    [fetchCredentials],
  );

  return {
    credentials,
    loading,
    error,
    refresh,
    createCredential,
    revokeCredential,
  };
}

export type { AdminNodeCredentialDto, CreatedNodeCredentialDto };
