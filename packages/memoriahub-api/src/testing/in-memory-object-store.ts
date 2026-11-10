import { Readable } from 'node:stream';

import type {
  MemoriahubDeleteManyResult,
  MemoriahubKeyPrefixDef,
  MemoriahubObjectProcessor,
  MemoriahubObjectStore,
  MemoriahubObjectStorePort,
  MemoriahubUploadOptions,
  MemoriahubUploadResult,
} from '../ports/index.js';

/** Reads a stream into one buffer (test-sized objects only). */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * One in-memory {@link MemoriahubObjectStore}: a map from key to bytes. Signed URLs are
 * `memory://<bucket>/<key>?expires=<seconds>`.
 *
 * @stability experimental
 */
export class InMemoryMemoriahubObjectStore implements MemoriahubObjectStore {
  /** The stored objects. */
  readonly objects = new Map<string, { bytes: Buffer; options: MemoriahubUploadOptions }>();

  /**
   * @param kind - the driver kind it reports.
   * @param bucket - the bucket it reports.
   */
  constructor(
    readonly kind = 'memory',
    private readonly bucket = 'memory-bucket',
  ) {}

  /** The bucket. */
  getBucket(): string {
    return this.bucket;
  }

  /**
   * Stores an object.
   *
   * @param key - the key.
   * @param body - the bytes.
   * @param options - the options.
   */
  async upload(key: string, body: Readable, options: MemoriahubUploadOptions): Promise<MemoriahubUploadResult> {
    this.objects.set(key, { bytes: await readAll(body), options });
    return { key, bucket: this.bucket };
  }

  /**
   * Streams an object out.
   *
   * @param key - the key.
   */
  async download(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`No such object: ${key}`);
    return Readable.from([object.bytes]);
  }

  /**
   * A fake signed GET.
   *
   * @param key - the key.
   * @param options - the lifetime.
   */
  async getSignedDownloadUrl(key: string, options?: { expiresIn?: number }): Promise<string> {
    return `memory://${this.bucket}/${key}?expires=${options?.expiresIn ?? 3600}`;
  }

  /**
   * A fake signed PUT.
   *
   * @param key - the key.
   * @param options - the lifetime.
   */
  async getSignedPutUrl(key: string, options?: { expiresIn?: number }): Promise<string> {
    return `memory://${this.bucket}/${key}?put=1&expires=${options?.expiresIn ?? 3600}`;
  }

  /**
   * Deletes an object; idempotent.
   *
   * @param key - the key.
   */
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /**
   * Deletes many objects.
   *
   * @param keys - the keys.
   */
  async deleteMany(keys: readonly string[]): Promise<MemoriahubDeleteManyResult> {
    for (const key of keys) this.objects.delete(key);
    return { deleted: [...keys], failed: [] };
  }

  /**
   * Whether an object exists.
   *
   * @param key - the key.
   */
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  /**
   * The size of an object, or `null`.
   *
   * @param key - the key.
   */
  async size(key: string): Promise<number | null> {
    return this.objects.get(key)?.bytes.byteLength ?? null;
  }
}

/**
 * An in-memory `MEMORIAHUB_OBJECT_STORE`: an active store plus one store per (provider, bucket) location,
 * with registries for key prefixes and processors.
 *
 * @stability experimental
 */
export class InMemoryMemoriahubObjectStorePort implements MemoriahubObjectStorePort {
  /** The store new uploads go to. */
  readonly activeStore = new InMemoryMemoriahubObjectStore('memory', 'active-bucket');

  /** The registered key prefixes, by id. */
  readonly prefixes = new Map<string, MemoriahubKeyPrefixDef>();

  /** The registered processors, in registration order. */
  readonly processors: MemoriahubObjectProcessor[] = [];

  /** Object ids the fake can sign for `signedUrlForObject`, with their keys. */
  readonly objectKeys = new Map<string, string>();

  private readonly locations = new Map<string, InMemoryMemoriahubObjectStore>();

  /** Active store. */
  async active(): Promise<{ id: string; store: MemoriahubObjectStore }> {
    return { id: this.activeStore.kind, store: this.activeStore };
  }

  /**
   * The store of a recorded location.
   *
   * @param provider - the recorded provider.
   * @param bucket - the recorded bucket.
   */
  async forLocation(provider: string | null | undefined, bucket?: string | null): Promise<MemoriahubObjectStore> {
    if (!provider) return this.activeStore;
    const id = `${provider}/${bucket ?? ''}`;
    let store = this.locations.get(id);
    if (!store) {
      store = new InMemoryMemoriahubObjectStore(provider, bucket ?? 'default');
      this.locations.set(id, store);
    }
    return store;
  }

  /**
   * A signed URL for an object id, or `null`.
   *
   * @param objectId - the object id.
   * @param expiresIn - the lifetime.
   */
  async signedUrlForObject(objectId: string, expiresIn?: number): Promise<string | null> {
    const key = this.objectKeys.get(objectId);
    return key ? this.activeStore.getSignedDownloadUrl(key, { expiresIn }) : null;
  }

  /**
   * Declares key prefixes; idempotent per id.
   *
   * @param defs - the prefixes.
   */
  registerKeyPrefixes(defs: readonly MemoriahubKeyPrefixDef[]): void {
    for (const def of defs) if (!this.prefixes.has(def.id)) this.prefixes.set(def.id, def);
  }

  /**
   * Registers a processor.
   *
   * @param processor - the processor.
   */
  registerProcessor(processor: MemoriahubObjectProcessor): void {
    this.processors.push(processor);
  }
}
