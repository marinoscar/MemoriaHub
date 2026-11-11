// =============================================================================
// What the enhancement slice needs of the host that is not a port (RETRO-J10, #624)
// =============================================================================
//
// Four hooks and one options object. The native image libraries (sharp, exiftool) stay with the host,
// so pixels and metadata go through `ENHANCEMENT_IMAGE_TOOLS`; the organization of a new storage row
// and the deployment-key status are the host's. Each token's description string is permanent.
// =============================================================================

/**
 * Injection token of {@link EnhancementImageTools}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const ENHANCEMENT_IMAGE_TOOLS = Symbol.for('@marinoscar/memoriahub/ENHANCEMENT_IMAGE_TOOLS');

/**
 * The image operations of the enhancement job that need a native library: the thumbnail derivative of
 * the staged bytes, the real pixel size of the returned image and the file-level metadata carry-over.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface EnhancementImageTools {
  /**
   * Renders the thumbnail JPEG of the staged bytes (the sizing, format and quality of every thumbnail).
   *
   * @param bytes - the staged result.
   * @param options - the source file name (a format hint for the transcode fallback).
   * @throws Error when the input cannot be decoded; the caller treats a thumbnail as best-effort.
   */
  renderThumbnail(bytes: Buffer, options: { sourceFilename: string }): Promise<Buffer>;

  /**
   * Reads the real pixel dimensions of an image, or `null` when it cannot be decoded. Never throws.
   *
   * @param bytes - the image.
   */
  readDimensions(bytes: Buffer): Promise<[number, number] | null>;

  /**
   * Copies the original's EXIF, GPS, IPTC, XMP and ICC onto the enhanced bytes and stamps the AI
   * marker. Best-effort by contract: returns the enhanced bytes unchanged on any failure.
   *
   * @param original - the original file's bytes.
   * @param enhanced - the enhanced JPEG.
   * @param options - the model, the output size and the original's extension.
   */
  carryOverMetadata(
    original: Buffer,
    enhanced: Buffer,
    options: { model: string; width: number; height: number; originalExtension: string },
  ): Promise<Buffer>;
}

/**
 * Injection token of {@link EnhancementKeyStatus}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const ENHANCEMENT_KEY_STATUS = Symbol.for('@marinoscar/memoriahub/ENHANCEMENT_KEY_STATUS');

/**
 * Whether the deployment holds a usable key for a provider (the admin status route reports it). The
 * answer carries no key material.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface EnhancementKeyStatus {
  /**
   * The deployment key's status for one provider.
   *
   * @param provider - the provider id.
   */
  status(provider: string): Promise<{ configured: boolean; enabled: boolean }>;
}

/**
 * Injection token of {@link EnhancementStorageOrg}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const ENHANCEMENT_STORAGE_ORG = Symbol.for('@marinoscar/memoriahub/ENHANCEMENT_STORAGE_ORG');

/**
 * The organization a derived storage row (the new object of a keep-both) is stamped with.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface EnhancementStorageOrg {
  /** The organization id (the single-organization default until multi-organization mode). */
  get(): Promise<string>;
}

/**
 * Injection token of {@link EnhancementModuleOptions}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const ENHANCEMENT_OPTIONS = Symbol.for('@marinoscar/memoriahub/ENHANCEMENT_OPTIONS');

/**
 * The queue's default budget of rate-limit deferrals before a job fails for good.
 *
 * @stability experimental
 */
export const DEFAULT_RATE_LIMIT_MAX_HITS = 10;

/**
 * Options of `EnhancementModule.forRoot`.
 *
 * @stability experimental
 */
export interface EnhancementModuleOptions {
  /**
   * The queue's budget of provider rate-limit deferrals before a job fails for good (default 10). The
   * handler mirrors the queue's retry decision into its row, so it needs the same number.
   */
  rateLimitMaxHits?: number;
  /**
   * Whether this instance schedules the hourly purge (default true). The host returns false on an
   * instance with no worker: only a worker creates and sweeps staging objects.
   */
  housekeepingEnabled?: () => boolean;
}
