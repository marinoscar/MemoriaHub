import { useState, useCallback } from 'react';
import { listInvites, createInvite, revokeInvite } from '../services/circles';
import { useIsMounted } from './useIsMounted';
import type { CircleInvite, CircleRole } from '../types/circles';

export function useCircleInvites(circleId: string) {
  const [invites, setInvites] = useState<CircleInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchInvites = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await listInvites(circleId);
      if (!isMounted()) return;
      setInvites(resp.items);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [circleId, isMounted]);

  const sendInvite = useCallback(
    async (email: string, role: CircleRole, notes?: string) => {
      const inv = await createInvite(circleId, { email, role, notes });
      if (isMounted()) setInvites((prev) => [...prev, inv]);
      return inv;
    },
    [circleId, isMounted],
  );

  const cancelInvite = useCallback(
    async (inviteId: string) => {
      await revokeInvite(circleId, inviteId);
      if (isMounted()) setInvites((prev) => prev.filter((x) => x.id !== inviteId));
    },
    [circleId, isMounted],
  );

  return { invites, loading, error, fetchInvites, sendInvite, cancelInvite };
}
