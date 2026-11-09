// =============================================================================
// Read-only legacy cipher for the AI key import (RETRO-E3, #605)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#605): DELETED IN RELEASE N+1, together with
// `ai_provider_credentials`.
//
// DECRYPT ONLY. The import reads `ai_provider_credentials.encrypted_key` (the
// pre-platform AES-256-GCM envelope under `SECRETS_ENCRYPTION_KEY`, no purpose
// binding) and hands the plaintext to `CredentialsService.setSecret`, which
// re-encrypts it in the platform envelope (purpose `ai`). Nothing in this
// module can encrypt in the legacy format, so no new legacy ciphertext can be
// produced through it.
//
// The envelope implementation is the one `src/legacy/legacy-secret-cipher.ts`
// already carries for the other carry-overs; this file re-exports its decrypt
// half only, so there is ONE implementation of the format and this command's
// dependency on it is a single line to delete.
// =============================================================================

import { decryptSecret } from '../../legacy/legacy-secret-cipher';

/**
 * Decrypts one legacy `ai_provider_credentials.encrypted_key`. Throws (with a
 * message that carries no key material) when the key cannot decrypt it.
 */
export function decryptLegacyAiKey(ciphertext: string): string {
  return decryptSecret(ciphertext);
}
