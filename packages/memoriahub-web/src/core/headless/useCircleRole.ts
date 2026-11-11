import { useMemo } from 'react';

import { useOwnerScope, usePermissions } from './hooks.js';

/**
 * The result of {@link useCircleRole}.
 *
 * @stability experimental
 */
export interface MemoriahubCircleRoleState {
  /** True for an administrator or a circle administrator. */
  isCircleAdmin: boolean;
  /** True when the user may write to the active circle (collaborator or above). */
  isCollaborator: boolean;
  /** True when the user may read the active circle (viewer or above). */
  isViewer: boolean;
  /** Alias of `isCollaborator`: the user may edit what the circle holds. */
  canEdit: boolean;
}

/**
 * What the signed-in user may do in the active owner scope, derived from the
 * per-circle role (a system administrator counts as a circle administrator).
 *
 * @returns the role flags.
 *
 * @stability experimental
 */
export function useCircleRole(): MemoriahubCircleRoleState {
  const { activeCircleRole } = useOwnerScope();
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

  return { isCircleAdmin, isCollaborator, isViewer, canEdit: isCollaborator };
}
