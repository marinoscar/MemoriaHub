import { useState, useCallback } from 'react';
import { listMembers, addMember, updateMemberRole, removeMember } from '../services/circles';
import { useIsMounted } from './useIsMounted';
import type { CircleMember, CircleRole } from '../types/circles';

export function useCircleMembers(circleId: string) {
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchMembers = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await listMembers(circleId);
      if (!isMounted()) return;
      setMembers(resp.items);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [circleId, isMounted]);

  const inviteMember = useCallback(
    async (userId: string, role: CircleRole) => {
      const m = await addMember(circleId, { userId, role });
      if (isMounted()) setMembers((prev) => [...prev, m]);
      return m;
    },
    [circleId, isMounted],
  );

  const changeRole = useCallback(
    async (userId: string, role: CircleRole) => {
      const m = await updateMemberRole(circleId, userId, role);
      if (isMounted()) setMembers((prev) => prev.map((x) => (x.userId === userId ? m : x)));
    },
    [circleId, isMounted],
  );

  const removeMemberById = useCallback(
    async (userId: string) => {
      await removeMember(circleId, userId);
      if (isMounted()) setMembers((prev) => prev.filter((x) => x.userId !== userId));
    },
    [circleId, isMounted],
  );

  return { members, loading, error, fetchMembers, inviteMember, changeRole, removeMemberById };
}
