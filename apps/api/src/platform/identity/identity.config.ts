// The role and permission registries must be filled before the first request:
// the invite, member and user-role routes ask the role registry what may be
// assigned. Imported for its side effect, once, here.
import '../../app-registrations/permission-manifest';
// The current-user extension (the raw `timezone`), registered at import time:
// the registry freezes once the application has bootstrapped.
import '../../app-registrations/identity';

import { IdentityModule } from '@marinoscar/platform-api/identity';

import { IdentityHostModule } from './identity-host.module';

// =============================================================================
// MemoriaHub's identity slice (RETRO-B2, issue #611)
// =============================================================================
//
// One `IdentityModule.forRoot()` in single-organization mode (TENANCY_MODE is
// left unset): sign-in, sessions and tokens, the guards and decorators every
// route uses, users, the allowlist, personal access tokens, the device flow and
// the organization routes, from `@marinoscar/platform-api/identity`. The host
// ports are bound by `IdentityHostModule`.
//
//   - `deviceFlow.returnUriSchemes: ['memoriahub']`: the Android Custom Tab
//     pairing sends `clientInfo.returnUri` (`memoriahub://...`); `https:` is
//     always accepted. `clientInfo.name` is accepted as the deprecated alias of
//     `deviceName` (EAB#1081, platform 0.1.0-next.22), so no local shim remains.
//   - `enableTestAuth`: `POST /api/auth/test/login`, mounted outside production
//     only (the package refuses it in production regardless). It replaces the
//     app's own `TestAuthModule`.
// =============================================================================

/** The test login is mounted outside production only. */
export function testAuthEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production';
}

export const identityModule = IdentityModule.forRoot({
  imports: [IdentityHostModule],
  enableTestAuth: testAuthEnabled(),
  initialAdminEmailEnv: 'INITIAL_ADMIN_EMAIL',
  deviceFlow: { returnUriSchemes: ['memoriahub'] },
});
