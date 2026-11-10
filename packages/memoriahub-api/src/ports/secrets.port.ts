// =============================================================================
// MEMORIAHUB_SECRETS: the secrets port (RETRO-J4, #610)
// =============================================================================
//
// The provider keys the domain itself owns: the CompreFace sidecar base URL override and the Google
// reverse-geocoding key (`face_compreface`, `geo_provider`). The web edition binds it over the platform
// encrypted credential store (AES-256-GCM, `SECRETS_ENCRYPTION_KEY`); a bare host uses its keychain.
// A user's AI key is NOT here: the AI port resolves it on its own side.
//
// `status` NEVER RETURNS MATERIAL: it reports whether a secret is set, a short hint and when it changed.
// Only `get`, called server-side by the code that spends the secret, returns the value, and the value is
// never logged, traced or returned from a controller.
// =============================================================================

/**
 * Injection token of {@link MemoriahubSecretsPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_SECRETS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_SECRETS');

/**
 * What is known about a stored secret without revealing it.
 *
 * @stability experimental
 */
export interface MemoriahubSecretStatus {
  /** True when a value is stored. */
  configured: boolean;
  /** A short non-reversible hint (the last four characters), or `null`. */
  hint: string | null;
  /** When the value last changed (ISO 8601), or `null`. */
  updatedAt: string | null;
}

/**
 * The secrets port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubSecretsPort {
  /**
   * Declares a purpose a secret may be stored under. A purpose is also its encryption domain: never
   * rename one. Idempotent.
   *
   * @param purpose - the purpose id.
   * @param label - what the secret is, for the admin screens.
   */
  registerPurpose(purpose: string, label: string): void;

  /**
   * The secret's value, or `null` when none is stored. Server-side use only.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   */
  get(purpose: string, name: string): Promise<string | null>;

  /**
   * Stores or replaces a secret.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   * @param value - the secret.
   * @param actorUserId - who changed it.
   */
  set(purpose: string, name: string, value: string, actorUserId: string): Promise<void>;

  /**
   * Removes a secret. Idempotent.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   * @param actorUserId - who removed it.
   */
  delete(purpose: string, name: string, actorUserId: string): Promise<void>;

  /**
   * Whether a secret is stored, without revealing it.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   */
  status(purpose: string, name: string): Promise<MemoriahubSecretStatus>;
}
