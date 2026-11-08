// =============================================================================
// The platform host: how packaged controllers authenticate (RETRO-B1, #597)
// =============================================================================
//
// Every packaged slice takes its route decorators from the app instead of
// shipping its own, so a packaged route is never public by accident. Until the
// identity slice is adopted (RETRO-B2) the answer is MemoriaHub's own `@Auth`
// and `@Public`; RETRO-B2 switches these three lines to
// `@marinoscar/platform-api/identity`.
//
// PLATFORM-ADOPTION-SHIM(#597): delegation to the app's `@Auth` / `@Public`.
// Removed by RETRO-B2 (docs/platform-adoption/local-exceptions.md).
// =============================================================================

import { definePlatformHost } from '@marinoscar/platform-api/core';

import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { PermissionName } from '../common/constants/roles.constants';

export const platformHost = definePlatformHost({
  access: {
    requirePermissions: (permissions) =>
      Auth({ permissions: [...permissions] as PermissionName[] }) as MethodDecorator &
        ClassDecorator,
    requireAuthenticated: () => Auth() as MethodDecorator & ClassDecorator,
    allowPublic: () => Public() as MethodDecorator & ClassDecorator,
  },
});
