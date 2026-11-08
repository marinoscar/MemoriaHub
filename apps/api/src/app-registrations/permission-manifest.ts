// =============================================================================
// Role and permission manifest (RETRO-B2, issue #611)
// =============================================================================
//
// Fills core's role and permission registries once, at import time, in seed
// order: platform roles, platform permissions of the selected slices, then
// MemoriaHub's own. The identity slice's invite, member and user-role routes ask
// the role registry what may be assigned, so this must be imported before the
// first request (`platform/identity/identity.config.ts` does). Never imported by
// `common/constants/roles.constants.ts` (a leaf of ~120 modules).

import { registerPlatformPermissions } from '@marinoscar/platform-api/manifest';

import { PLATFORM_PERMISSION_OPTIONS } from './permissions';

registerPlatformPermissions(PLATFORM_PERMISSION_OPTIONS);
