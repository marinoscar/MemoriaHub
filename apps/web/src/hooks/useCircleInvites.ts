import { useState, useCallback } from 'react';
import { listInvites, createInvite, revokeInvite } from '../services/circles';
import type { CircleInvite, CircleRole } from '../types/circles';

export function useCircleInvites(circleId: string) {
  const [invites, setInvites] = useState<CircleInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInvites = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await listInvites(circleId);
      setInvites(resp.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      setLoading(false);
    }
  }, [circleId]);

  const sendInvite = useCallback(
    async (email: string, role: CircleRole, notes?: string) => {
      const inv = await createInvite(circleId, { email, role, notes });
      setInvites((prev) => [...prev, inv]);
      return inv;
    },
    [circleId],
  );

  const cancelInvite = useCallback(
    async (inviteId: string) => {
      await revokeInvite(circleId, inviteId);
      setInvites((prev) => prev.filter((x) => x.id !== inviteId));
    },
    [circleId],
  );

  return { invites, loading, error, fetchInvites, sendInvite, cancelInvite };
}
