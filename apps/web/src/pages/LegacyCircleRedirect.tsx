/**
 * `/circles/:id` (RETRO-I6, #588): a shared circle is the platform group with
 * the SAME id, so the old URL lands on `/settings/groups/:id`. The personal
 * library is not a group (it has no members to manage): its old URL lands on
 * the groups list.
 */
import { Navigate, useParams } from 'react-router-dom';
import { useOwnerScope } from '../hooks/useOwnerScope';

export default function LegacyCircleRedirect() {
  const { id } = useParams<{ id: string }>();
  const { personalLibraryId } = useOwnerScope();
  const target = !id || id === personalLibraryId ? '/settings/groups' : `/settings/groups/${encodeURIComponent(id)}`;
  return <Navigate to={target} replace />;
}
