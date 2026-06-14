import { useState, useCallback } from 'react';
import { listMembers, addMember, updateMemberRole, removeMember } from '../services/circles';
import type { CircleMember, CircleRole } from '../types/circles';

export function useCircleMembers(circleId: string) {
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await listMembers(circleId);
      setMembers(resp.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [circleId]);

  const inviteMember = useCallback(
    async (userId: string, role: CircleRole) => {
      const m = await addMember(circleId, { userId, role });
      setMembers((prev) => [...prev, m]);
      return m;
    },
    [circleId],
  );

  const changeRole = useCallback(
    async (userId: string, role: CircleRole) => {
      const m = await updateMemberRole(circleId, userId, role);
      setMembers((prev) => prev.map((x) => (x.userId === userId ? m : x)));
    },
    [circleId],
  );

  const removeMemberById = useCallback(
    async (userId: string) => {
      await removeMember(circleId, userId);
      setMembers((prev) => prev.filter((x) => x.userId !== userId));
    },
    [circleId],
  );

  return { members, loading, error, fetchMembers, inviteMember, changeRole, removeMemberById };
}
