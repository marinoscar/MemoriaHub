/**
 * The caller's pending group invitations on Home (RETRO-I6, #588): the sharing
 * slice's `PendingGroupInvites`, hidden while there is none. Accepting one
 * reloads the owner switcher so the new shared library is listed at once.
 * Rendered only under the platform host (the packaged list reads its transport).
 */
import { lazy, Suspense, useContext } from 'react';
import { Box } from '@mui/material';
import { useOptionalPlatformHost } from '@marinoscar/platform-web/core';
import { OwnerScopeContext } from '../../contexts/OwnerScopeContext';

const PendingGroupInvites = lazy(() =>
  import('@marinoscar/platform-web/sharing/ui').then((module) => ({ default: module.PendingGroupInvites })),
);

export function HomeGroupInvites() {
  const host = useOptionalPlatformHost();
  const refreshScopes = useContext(OwnerScopeContext)?.refreshScopes;
  if (!host) return null;
  return (
    <Suspense fallback={null}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 3 } }}>
        <PendingGroupInvites
          hideWhenEmpty
          onChanged={(event) => {
            if (event.accepted && refreshScopes) void refreshScopes();
          }}
        />
      </Box>
    </Suspense>
  );
}
