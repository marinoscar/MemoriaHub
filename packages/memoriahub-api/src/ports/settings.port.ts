import type { z } from 'zod';

// =============================================================================
// MEMORIAHUB_SETTINGS: the settings port (RETRO-J4, #610)
// =============================================================================
//
// The settings namespaces the domain owns: `features`, `memories`, `workflows`, `dedup`, `burst`,
// `locationInference`, `locationGrouping`, `socialMedia`, `pictureEnhancement`, `reviewRuns`,
// `autoTagging`, `face`, `geo`, `backup`, `storage`, and the per-user `memories`, `search` and
// `timezone`. The web edition binds it over the platform settings registries (validation, versioning,
// audit, the cached read); a bare host keeps a local file or table.
//
// A SECRET IS NEVER A SETTING: a provider key goes through the secrets port.
//
// NAMESPACES ARE DECLARED BEFORE THE APPLICATION STARTS. The host composes request bodies and the API
// document from its registries when the settings slice is created, then freezes them, so the web
// edition declares each namespace in `app-registrations/settings.ts`; `registerNamespace` there VERIFIES
// the declaration exists and remembers the defaults, and throws a clear error when it does not.
// =============================================================================

/**
 * Injection token of {@link MemoriahubSettingsPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_SETTINGS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_SETTINGS');

/**
 * Declares a settings namespace.
 *
 * @stability experimental
 */
export interface MemoriahubSettingsNamespaceDef {
  /** `system` is deployment-wide; `user` is one value per user. */
  scope: 'system' | 'user';
  /** The namespace key. Persisted; never renamed. */
  name: string;
  /** The stored shape. */
  schema: z.ZodType;
  /** The value of a namespace nobody has written. */
  defaults: unknown;
}

/**
 * A system namespace with the version it was read at.
 *
 * @stability experimental
 */
export interface MemoriahubVersionedSettings<T> {
  /** The stored value, merged over the defaults. */
  value: T;
  /** The version; it rises by one on every write of the settings document. */
  version: number;
}

/**
 * The settings port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubSettingsPort {
  /**
   * Declares a namespace. Idempotent for the same declaration; call it at import or start-up time.
   *
   * @param def - the declaration.
   */
  registerNamespace(def: MemoriahubSettingsNamespaceDef): void;

  /**
   * Reads one system namespace with its version. Reads are cached for a few seconds by the host, so
   * a bulk import reads its feature flags once, not once per file.
   *
   * @param name - the namespace key.
   */
  readSystem<T>(name: string): Promise<MemoriahubVersionedSettings<T>>;

  /**
   * Reads one system namespace WITHOUT creating anything: the host's read-only path (a store that
   * writes its defaults on first read would break the diagnostics' read-only rule on a fresh install).
   * Not cached. Optional: a host whose reads never write binds `readSystem` alone, and a diagnostics
   * read falls back to it.
   *
   * @param name - the namespace key.
   */
  peekSystem?<T>(name: string): Promise<MemoriahubVersionedSettings<T>>;

  /**
   * Merges a patch into a system namespace. Drops the host's cache.
   *
   * @param name - the namespace key.
   * @param patch - the fields to change.
   * @param ctx - the acting user, and the version the caller read (a mismatch is refused).
   */
  patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<MemoriahubVersionedSettings<T>>;

  /**
   * Reads one user's namespace (the defaults when the user has none).
   *
   * @param userId - the user.
   * @param name - the namespace key.
   */
  readUser<T>(userId: string, name: string): Promise<T>;

  /**
   * Merges a patch into one user's namespace.
   *
   * @param userId - the user.
   * @param name - the namespace key.
   * @param patch - the fields to change.
   */
  patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T>;

  /**
   * The IANA zone one user's dates follow (`America/Chicago`), failing OPEN to `'UTC'`: a time-zone
   * lookup must never be the reason a listing fails. A capture date is a civil fact and never reads this.
   *
   * @param userId - the user.
   */
  readUserTimeZone(userId: string): Promise<string>;
}
