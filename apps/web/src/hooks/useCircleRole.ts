import { useMemo } from 'react';
import { useCircle } from './useCircle';
import { usePermissions } from './usePermissions';

export function useCircleRole() {
  const { activeCircleRole } = useCircle();
  const { isAdmin } = usePermissions();

  const isCircleAdmin = useMemo(
    () => isAdmin || activeCircleRole === 'circle_admin',
    [isAdmin, activeCircleRole],
  );

  const isCollaborator = useMemo(
    () => isCircleAdmin || activeCircleRole === 'collaborator',
    [isCircleAdmin, activeCircleRole],
  );

  const isViewer = useMemo(
    () => isCollaborator || activeCircleRole === 'viewer',
    [isCollaborator, activeCircleRole],
  );

  const canEdit = isCollaborator;

  return { isCircleAdmin, isCollaborator, isViewer, canEdit };
}
