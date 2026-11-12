import type { Readable } from 'node:stream';

// =============================================================================
// MEMORIAHUB_OBJECT_STORE: the object-store port (RETRO-J4, #610)
// =============================================================================
//
// Where media bytes, thumbnails, face frames, enhanced copies and avatars live. The web
// edition binds it over the platform storage slice (the active driver plus the router that
// builds the driver a row RECORDED); a bare host binds a local-disk store.
//
// TWO QUESTIONS, TWO METHODS:
//   `active()`                   where do NEW bytes go? The id is what a row records in `storage_provider`.
//   `forLocation(provider, bkt)` where do THIS row's bytes live? Always resolve the RECORDED
//                                provider, never the currently active one, or objects written before a
//                                driver switch become unreachable.
//
// BYTES ARE NEVER BUFFERED WHOLE: `upload` takes a stream, `download` returns one, and a client
// reads a large object through `signedDownloadUrl` (a Range request goes to the URL, not through
// the API). No bucket URL is ever exposed to a browser.
// =============================================================================

/**
 * Injection token of {@link MemoriahubObjectStorePort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_OBJECT_STORE = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_OBJECT_STORE');

/**
 * Options of {@link MemoriahubObjectStore.upload}.
 *
 * @stability experimental
 */
export interface MemoriahubUploadOptions {
  /** The MIME type to store. */
  mimeType: string;
  /** The byte length, when known (a provider needs it for a non-seekable stream). */
  contentLength?: number;
  /** String metadata stored beside the object. */
  metadata?: Record<string, string>;
  /** The `Cache-Control` to store (a content-addressed thumbnail is `public, max-age=31536000, immutable`). */
  cacheControl?: string;
}

/**
 * What an upload returns.
 *
 * @stability experimental
 */
export interface MemoriahubUploadResult {
  /** The object key. */
  key: string;
  /** The bucket it landed in. */
  bucket: string;
  /** The entity tag, when the provider reports one. */
  eTag?: string;
}

/**
 * The result of a batched delete.
 *
 * @stability experimental
 */
export interface MemoriahubDeleteManyResult {
  /** The keys that were deleted (or were already gone). */
  deleted: string[];
  /** The keys that could not be deleted, with why. */
  failed: Array<{ key: string; message: string }>;
}

/**
 * What a store can do with a multipart upload a phone drives: whether it hands out presigned part URLs
 * (S3, R2) or takes the part bytes through the API (local disk, `proxied`), and whether it can accept a
 * part body at all.
 *
 * @stability experimental
 */
export interface MemoriahubObjectStoreCapabilities {
  /** `presigned` when a client puts each part to a URL; `proxied` when the part goes through the API. */
  readonly partUploadMode: 'presigned' | 'proxied';
  /** True when the store can write a part body it is given (what a `proxied` store needs). */
  readonly acceptsPartBytes: boolean;
}

/**
 * One object store: a driver bound to a bucket.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubObjectStore {
  /**
   * What the store can do with a client-driven multipart upload. Optional: a diagnostic that needs it
   * reports "unknown" when the host does not say.
   */
  readonly capabilities?: MemoriahubObjectStoreCapabilities;

  /** The driver kind (`s3`, `r2`, `local`, ...). */
  readonly kind: string;

  /** The bucket this store writes to. */
  getBucket(): string;

  /**
   * Streams an object in. The stream is consumed; the object is never buffered whole.
   *
   * @param key - the object key.
   * @param body - the bytes.
   * @param options - the MIME type and the rest.
   */
  upload(key: string, body: Readable, options: MemoriahubUploadOptions): Promise<MemoriahubUploadResult>;

  /**
   * Streams an object out.
   *
   * @param key - the object key.
   * @throws Error when the object does not exist.
   */
  download(key: string): Promise<Readable>;

  /**
   * A short-lived signed GET for the object. Range requests go to this URL.
   *
   * @param key - the object key.
   * @param options - the lifetime in seconds and an optional `Content-Disposition`.
   */
  getSignedDownloadUrl(key: string, options?: { expiresIn?: number; responseContentDisposition?: string }): Promise<string>;

  /**
   * A short-lived signed PUT for a direct upload (a worker node's output).
   *
   * @param key - the object key (chosen by the server, never by the node).
   * @param options - the lifetime in seconds and the content type the PUT must carry.
   */
  getSignedPutUrl(key: string, options?: { expiresIn?: number; contentType?: string }): Promise<string>;

  /**
   * Deletes an object. Idempotent: a missing key is not an error.
   *
   * @param key - the object key.
   */
  delete(key: string): Promise<void>;

  /**
   * Deletes many objects in as few provider calls as it can (S3 takes 1,000 keys per call).
   *
   * @param keys - the object keys.
   */
  deleteMany(keys: readonly string[]): Promise<MemoriahubDeleteManyResult>;

  /**
   * Whether an object exists.
   *
   * @param key - the object key.
   */
  exists(key: string): Promise<boolean>;

  /**
   * The size of an object in bytes, or `null` when it does not exist.
   *
   * @param key - the object key.
   */
  size(key: string): Promise<number | null>;
}

/**
 * The fields of an uploaded object a post-upload processor reads.
 *
 * @stability experimental
 */
export interface MemoriahubStoredObject {
  /** The object id. */
  id: string;
  /** The object key. */
  storageKey: string;
  /** The MIME type. */
  mimeType: string;
  /** The recorded size, as a string (a BigInt column). */
  size?: string | number | bigint | null;
  /** The driver the row recorded. */
  storageProvider?: string | null;
  /** The bucket the row recorded. */
  bucket?: string | null;
  /** The row's metadata document. */
  metadata?: unknown;
  /** Every other column the host passes through. */
  [column: string]: unknown;
}

/**
 * What a processor reports for one object.
 *
 * @stability experimental
 */
export interface MemoriahubObjectProcessorResult {
  /** Whether it succeeded. */
  success: boolean;
  /** Facts merged into the row's metadata. */
  metadata?: Record<string, unknown>;
  /** The failure, when `success` is false. */
  error?: string;
}

/**
 * A post-upload step (content hash, EXIF, thumbnail ...) run by the host's object-processing job.
 *
 * @extensionPoint hook
 * @stability experimental
 */
export interface MemoriahubObjectProcessor {
  /** A short unique name; recorded in the row's processing metadata. */
  readonly name: string;
  /** Lower runs first; equal priorities keep registration order. */
  readonly priority: number;
  /** True when a failure must not fail the whole object as long as another processor succeeded. */
  readonly optional?: boolean;

  /**
   * Whether this processor applies to the object.
   *
   * @param object - the uploaded object.
   */
  canProcess(object: MemoriahubStoredObject): boolean;

  /**
   * Processes the object.
   *
   * @param object - the uploaded object.
   * @param getStream - opens the object's bytes; call it only when the bytes are needed.
   */
  process(object: MemoriahubStoredObject, getStream: () => Promise<Readable>): Promise<MemoriahubObjectProcessorResult>;
}

/**
 * Declares an object-key prefix a feature writes under, so a purge or a reset knows who owns it.
 *
 * @stability experimental
 */
export interface MemoriahubKeyPrefixDef {
  /** A stable id. */
  readonly id: string;
  /** The prefix, ending in `/`. */
  readonly prefix: string;
  /** The feature that owns it. */
  readonly owner: string;
  /** What lives there. */
  readonly description: string;
  /** `deployment` prefixes are never touched by a user-data reset. */
  readonly scope?: 'user' | 'org' | 'deployment';
  /** True when a factory reset keeps the prefix. */
  readonly survivesFactoryReset?: boolean;
}

/**
 * The object-store port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubObjectStorePort {
  /**
   * The store new uploads go to, and the id a row records in `storage_provider`.
   *
   * @throws Error (the host's "not configured" refusal) when no driver is configured.
   */
  active(): Promise<{ id: string; store: MemoriahubObjectStore }>;

  /**
   * The store of a recorded location: the driver a row names, with the row's bucket. A row with no
   * recorded provider is served by the active driver.
   *
   * @param provider - the row's `storage_provider`.
   * @param bucket - the row's `bucket` (`null` means the driver's current one).
   */
  forLocation(provider: string | null | undefined, bucket?: string | null): Promise<MemoriahubObjectStore>;

  /**
   * A signed GET for a storage object's bytes, for SERVER-TRUSTED callers only (the worker-node
   * claim, the backup feed): it checks no ownership and accepts an object still `processing`.
   * Never expose it on a user route.
   *
   * @param objectId - the storage object id.
   * @param expiresIn - the lifetime in seconds.
   * @returns the URL, or `null` when the row is missing or has no key.
   */
  signedUrlForObject(objectId: string, expiresIn?: number): Promise<string | null>;

  /**
   * Declares object-key prefixes. Idempotent per id; call it at import or start-up time, before the
   * host freezes its registries.
   *
   * @param defs - the prefixes.
   */
  registerKeyPrefixes(defs: readonly MemoriahubKeyPrefixDef[]): void;

  /**
   * Registers a post-upload processor. Equal priorities keep registration order, so register all of a
   * slice's processors from one place.
   *
   * @param processor - the processor.
   */
  registerProcessor(processor: MemoriahubObjectProcessor): void;
}
