// =============================================================================
// The host's side of the memories slice
// =============================================================================
//
// What the slice needs that is not a port: whether the host allows it at all, the digest's signing
// keys and e-mail readiness, and the one action that is the host's own (saving a memory as an album,
// which reuses the host's album code so it inherits its checks and bookkeeping).
// =============================================================================

/**
 * Injection token of {@link MemoriesHostOptions}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIES_OPTIONS = Symbol.for('@marinoscar/memoriahub/MEMORIES_OPTIONS');

/**
 * Injection token of {@link MemoriesAlbumsPort}. The host provides it through the `providers` of
 * `MemoriesModule.forRoot`.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIES_ALBUMS = Symbol.for('@marinoscar/memoriahub/MEMORIES_ALBUMS');

/**
 * Injection token of {@link MemoriesEmailReadiness}. Optional: a host that gives none is taken as able to
 * deliver mail, and the send itself reports the failure.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIES_EMAIL_READINESS = Symbol.for('@marinoscar/memoriahub/MEMORIES_EMAIL_READINESS');

/**
 * Whether the deployment can deliver mail (in the web edition: the e-mail settings are enabled with a
 * provider and a from address, the precondition the e-mail channel applies before it sends). Asked by the
 * digest cron and the handler, so a deployment with no transport queues no digest job.
 *
 * @stability experimental
 */
export interface MemoriesEmailReadiness {
  /** True when mail can be delivered. Must not throw (a failure counts as not ready). */
  isReady(): Promise<boolean>;
}

/**
 * Digest options of the host.
 *
 * @stability experimental
 */
export interface MemoriesDigestOptions {
  /**
   * The HMAC key of one signing purpose (`memory-digest-image`, `memory-digest-unsubscribe`). The host
   * derives it from its secrets key (never inside the package); each purpose must be a different key,
   * so an image token can never be replayed as an unsubscribe token. A key the host has derived the
   * same way before the slice moved keeps every minted token valid.
   */
  signingKey: (purpose: string) => Buffer;
  /** The base URL of absolute links in the mail. Defaults to the `APP_URL` environment variable. */
  appUrl?: () => string | undefined;
}

/**
 * The options the host gives `MemoriesModule.forRoot`.
 *
 * @stability experimental
 */
export interface MemoriesHostOptions {
  /**
   * A host-level switch: when it returns `false` the slice is off whatever `features.memories` says.
   * Defaults to on. It is read on every gate, so it may change at run time.
   */
  enabled?: () => boolean;
  /** The digest's signing keys, e-mail readiness and base URL. */
  digest: MemoriesDigestOptions;
}

/**
 * Saving a memory as an album, over the host's album code (it checks the caller's role, keeps the
 * backup-feed bookkeeping and validates the cover), so the slice cannot drift from it.
 *
 * @stability experimental
 */
export interface MemoriesAlbumsPort {
  /**
   * Creates an album.
   *
   * @param input - the owner scope and the album name.
   * @param userId - the caller.
   * @param permissions - the caller's permissions.
   * @returns the new album's id.
   */
  createAlbum(
    input: { circleId: string; name: string },
    userId: string,
    permissions: string[],
  ): Promise<{ id: string }>;
  /**
   * Adds media items to an album in order.
   *
   * @param albumId - the album.
   * @param mediaItemIds - the items, in the order they should read back.
   * @param userId - the caller.
   * @param permissions - the caller's permissions.
   */
  addAlbumItems(albumId: string, mediaItemIds: string[], userId: string, permissions: string[]): Promise<void>;
  /**
   * Sets the album cover (the item must be a member).
   *
   * @param albumId - the album.
   * @param coverMediaItemId - the cover item.
   * @param userId - the caller.
   * @param permissions - the caller's permissions.
   */
  setAlbumCover(albumId: string, coverMediaItemId: string, userId: string, permissions: string[]): Promise<void>;
}

/**
 * Injection token of {@link MemoriesGenerationHook}. Optional: the host provides it through the
 * `providers` of `MemoriesModule.forRoot` when it wants to hear of a generation run that created memories.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIES_GENERATION_HOOK = Symbol.for('@marinoscar/memoriahub/MEMORIES_GENERATION_HOOK');

/**
 * Told after a `memory_generation` run that CREATED memories (a refresh-only run raises nothing). The
 * web edition raises its `memories.memory.created` webhook here. It must not throw; the handler
 * swallows a failure anyway, because every memory is already committed.
 *
 * @stability experimental
 */
export interface MemoriesGenerationHook {
  /**
   * A generation pass in `circleId` that started at `since` created memories.
   *
   * @param circleId - the owner scope.
   * @param since - the run's start.
   */
  memoriesCreated(circleId: string, since: Date): Promise<void>;
}
