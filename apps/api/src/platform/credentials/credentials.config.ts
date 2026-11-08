// =============================================================================
// The credentials slice's composition (RETRO-B4, #617)
// =============================================================================
//
// `CredentialsModule` is the platform's encrypted `(purpose, name)` store (deployment tier). It is
// NOT global: a module that reads a plaintext secret imports it, so every reader is a visible line.
// The user and organization tiers are not mounted; nothing here needs them yet.
//
// The purposes are declared by the manifest import below, before bootstrap freezes the registry.
// =============================================================================

import { CredentialsModule } from '@marinoscar/platform-api/credentials';

import './credential-purposes.manifest';

export { CredentialsModule };
export const credentialsModules = [CredentialsModule] as const;
