import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile, readFile, statfs } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { deriveSigningKey } from '@marinoscar/platform-api/core';
import {
  MultipartPartsMissingError,
  MultipartSessionNotFoundError,
  PartSizeMismatchError,
  type MultipartUploadInit,
  type SignedUrlOptions,
  type StorageDriverDefinition,
  type StorageDriverTestResult,
  type StorageProvider,
  type StoredPart,
  type StorageUploadOptions,
  type StorageUploadResult,
  type UploadPart,
  type UploadedPart,
} from '@marinoscar/platform-api/storage';
import { z } from 'zod';

// =============================================================================
// The `local` storage driver: objects as files on the API host (RETRO-D1, #563)
// =============================================================================
//
// MemoriaHub's local-disk provider, moved onto the platform's driver registry
// (`registerStorageDriver`, `app-registrations/storage.ts`). Before RETRO-D1 it
// was `storage/providers/local/local-disk.provider.ts`, rooted at the
// `BACKUP_LOCAL_PATH` environment variable; now the root is the driver's
// `rootDir` setting (`storage.drivers.local.rootDir`, edited at
// /admin/settings/storage). `scripts/migrate-storage-settings.ts` copies the old
// variable's value into it once; the variable is no longer read.
//
// THE ID IS PERMANENT: `local` is what `storage_objects.storage_provider` (and the
// staging, backup and release rows) recorded for every object written here, and
// what `storage.provider` names when the driver is active.
//
// THE LAYOUT ON DISK IS UNCHANGED, so every object written before the cutover
// is read where it lies:
//
//   <rootDir>/<key>                         the bytes (keys keep their `/` as folders)
//   <rootDir>/<key>.meta.json               the content type and the object's metadata
//   <rootDir>/.multipart/<uploadId>/        an open resumable upload: `.init.json`, `part-<n>`
//
// RESUMABLE UPLOADS go through the API: the driver has no presigned part URLs,
// so it declares `partUploadMode: 'proxied'`, the platform answers
// `partUploadAuth: 'bearer'` on `upload/init`, and the client (web, CLI, the
// Android app) PUTs each part to `PUT /api/storage/objects/:id/upload/parts/:n`.
// The platform bounds the body to the part size; `uploadPart` streams it into a
// temp file (never buffered), checks the byte count and answers the part's MD5.
//
// SIGNED DOWNLOAD URLS are same-origin: `<appOrigin>/api/storage/local/objects/<token>`,
// a token `base64url(payload).base64url(mac)` under
// `deriveSigningKey('memoriahub-local-storage')` (a sub-key of
// `SECRETS_ENCRYPTION_KEY`: no new secret, no environment variable).
// `LocalStorageDownloadController` verifies it and streams the file. Before
// RETRO-D1 this provider answered `file://` URLs, which no browser could open.
//
// NOT SUPPORTED, DECLARED RATHER THAN HIDDEN: signed PUT URLs (the worker-node
// output upload) need a route that accepts a whole object from a node; they
// raise a clear error, as they never worked on this provider.
// =============================================================================

/** The driver id: `storage.provider`, `StorageProvider.kind` and `storage_objects.storage_provider`. */
export const LOCAL_DRIVER_ID = 'local';

/** The root a deployment that never configured one used before RETRO-D1 (`BACKUP_LOCAL_PATH`'s default). */
export const LOCAL_DEFAULT_ROOT_DIR = '/tmp/memoriahub-backup';

/** The signing domain of this driver's download URLs. Permanent in practice (links live minutes). */
export const LOCAL_SIGNING_PURPOSE = 'memoriahub-local-storage';

/** The path the signed download URLs point at, under the API prefix. */
export const LOCAL_DOWNLOAD_PATH = '/api/storage/local/objects/';

const DEFAULT_URL_TTL_SECONDS = 3600;

/** The driver's settings: where on the host the objects live. */
export const localSettingsSchema = z.object({
  rootDir: z
    .string()
    .trim()
    .max(1024)
    .meta({ label: 'Root directory' })
    .describe(
      `Absolute path of the folder the objects are written under. Leave empty for ${LOCAL_DEFAULT_ROOT_DIR} ` +
        '(the default of the former BACKUP_LOCAL_PATH variable). Changing it strands every object already written.',
    ),
});

/** The parsed settings. */
export type LocalSettings = z.infer<typeof localSettingsSchema>;

/** The root in force: the configured one, else the historical default. */
export function resolveLocalRootDir(settings: Partial<LocalSettings>): string {
  const configured = typeof settings.rootDir === 'string' ? settings.rootDir.trim() : '';
  return path.resolve(configured === '' ? LOCAL_DEFAULT_ROOT_DIR : configured);
}

// ---- signed tokens ----------------------------------------------------------------

function mac(payload: string): Buffer {
  return createHmac('sha256', deriveSigningKey(LOCAL_SIGNING_PURPOSE)).update(payload).digest();
}

/** The claims a download token carries. */
export interface LocalDownloadClaims {
  /** The root the object was written under (the `bucket` of the row is only its basename). */
  root: string;
  /** The object key. */
  key: string;
  /** `Content-Disposition` to answer with, when the signer asked for one. */
  disposition?: string;
}

/**
 * Signs a token granting a read of `key` under `root` until `expiresAt` (epoch seconds).
 */
export function signLocalDownloadToken(claims: LocalDownloadClaims, expiresAt: number): string {
  const payload = Buffer.from(
    JSON.stringify({ r: claims.root, k: claims.key, e: expiresAt, ...(claims.disposition ? { d: claims.disposition } : {}) }),
  ).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

/** What {@link verifyLocalDownloadToken} answers. */
export type LocalDownloadVerdict = ({ ok: true } & LocalDownloadClaims) | { ok: false; reason: 'invalid' | 'expired' };

/** Verifies a token: well formed, signed by this deployment, not expired. */
export function verifyLocalDownloadToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): LocalDownloadVerdict {
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length > 0) return { ok: false, reason: 'invalid' };
  const expected = mac(payload);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'invalid' };
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims['r'] !== 'string' || typeof claims['k'] !== 'string' || typeof claims['e'] !== 'number') {
      return { ok: false, reason: 'invalid' };
    }
    if (claims['e'] < nowSeconds) return { ok: false, reason: 'expired' };
    return {
      ok: true,
      root: claims['r'],
      key: claims['k'],
      ...(typeof claims['d'] === 'string' ? { disposition: claims['d'] } : {}),
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

// ---- the provider -------------------------------------------------------------------

/** Counts and MD5-hashes the bytes of one part, failing past `limit`. */
class PartMeter extends Transform {
  readonly hash = createHash('md5');
  bytes = 0;
  exceeded = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.exceeded = true;
      cb(new Error('part exceeds expected size'));
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

function normalizeETag(eTag: string): string {
  return eTag.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
}

/** Resolves `key` under `root`, refusing a key that would escape it. */
export function resolveLocalObjectPath(root: string, key: string): string {
  if (
    key === '' ||
    key.includes('\0') ||
    key.includes('\\') ||
    key.startsWith('/') ||
    key.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`Refusing the object key ${JSON.stringify(key)}: keys are relative paths without "." or ".." segments.`);
  }
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) {
    throw new Error(`Refusing the object key ${JSON.stringify(key)}: it escapes the storage root.`);
  }
  return full;
}

/**
 * The `StorageProvider` of the `local` driver: objects as files under one directory.
 */
export class LocalDiskStorageProvider implements StorageProvider {
  readonly kind = LOCAL_DRIVER_ID;
  /** No presigned part URLs: resumable uploads stream through the API's part route. */
  readonly partUploadMode = 'proxied' as const;

  constructor(
    private readonly root: string,
    private readonly appOrigin: string = '',
  ) {}

  /** The root's basename: what every row written here recorded as its `bucket`. */
  getBucket(): string {
    return path.basename(this.root) || 'local-backup';
  }

  /** The absolute root (the download route checks a token's root against it). */
  getRootDir(): string {
    return this.root;
  }

  private pathOf(key: string): string {
    return resolveLocalObjectPath(this.root, key);
  }

  private sidecarPath(fullPath: string): string {
    return `${fullPath}.meta.json`;
  }

  private partsDir(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new MultipartSessionNotFoundError(uploadId);
    return path.join(this.root, '.multipart', uploadId);
  }

  private partFile(uploadId: string, partNumber: number): string {
    return path.join(this.partsDir(uploadId), `part-${partNumber}`);
  }

  async upload(key: string, stream: Readable, options: StorageUploadOptions): Promise<StorageUploadResult> {
    const fullPath = this.pathOf(key);
    await mkdir(path.dirname(fullPath), { recursive: true });
    const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
    try {
      await pipeline(stream, fs.createWriteStream(tmpPath));
      await rename(tmpPath, fullPath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
    const size = (await stat(fullPath)).size;
    await writeFile(
      this.sidecarPath(fullPath),
      JSON.stringify({ mimeType: options.mimeType, metadata: options.metadata ?? {}, size, createdAt: new Date().toISOString() }, null, 2),
    );
    return { key, bucket: this.getBucket(), location: fullPath };
  }

  async download(key: string): Promise<Readable> {
    const fullPath = this.pathOf(key);
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) throw new Error(`File not found: ${key}`);
    return fs.createReadStream(fullPath);
  }

  async getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    this.pathOf(key);
    const expiresAt = Math.floor(Date.now() / 1000) + (options?.expiresIn ?? DEFAULT_URL_TTL_SECONDS);
    const token = signLocalDownloadToken(
      { root: this.root, key, ...(options?.responseContentDisposition ? { disposition: options.responseContentDisposition } : {}) },
      expiresAt,
    );
    return `${this.appOrigin}${LOCAL_DOWNLOAD_PATH}${token}`;
  }

  async getSignedPutUrl(): Promise<string> {
    throw new Error(
      'The local storage driver has no signed PUT URLs (worker-node output uploads): select an S3-compatible driver for node offload.',
    );
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.pathOf(key);
    await rm(fullPath, { force: true });
    await rm(this.sidecarPath(fullPath), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return (await stat(this.pathOf(key)).catch(() => null))?.isFile() === true;
  }

  async getMetadata(key: string): Promise<Record<string, string> | null> {
    const fullPath = this.pathOf(key);
    if (!(await this.exists(key))) return null;
    try {
      const parsed = JSON.parse(await readFile(this.sidecarPath(fullPath), 'utf-8')) as { metadata?: Record<string, string> };
      return parsed.metadata ?? {};
    } catch {
      return {};
    }
  }

  async setMetadata(key: string, metadata: Record<string, string>): Promise<void> {
    const sidecar = this.sidecarPath(this.pathOf(key));
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(sidecar, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no sidecar yet */
    }
    existing['metadata'] = { ...((existing['metadata'] as Record<string, string>) ?? {}), ...metadata };
    await writeFile(sidecar, JSON.stringify(existing, null, 2));
  }

  /** The content type recorded when the object was written (`application/octet-stream` when unknown). */
  async contentTypeOf(key: string): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(this.sidecarPath(this.pathOf(key)), 'utf-8')) as { mimeType?: unknown };
      return typeof parsed.mimeType === 'string' && parsed.mimeType !== '' ? parsed.mimeType : 'application/octet-stream';
    } catch {
      return 'application/octet-stream';
    }
  }

  /** The object's size in bytes, or `null` when it does not exist (the platform's optional `size` probe). */
  async size(key: string): Promise<number | null> {
    const info = await stat(this.pathOf(key)).catch(() => null);
    return info?.isFile() ? info.size : null;
  }

  async initMultipartUpload(key: string, options: StorageUploadOptions): Promise<MultipartUploadInit> {
    this.pathOf(key);
    const uploadId = randomUUID();
    const dir = this.partsDir(uploadId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.init.json'), JSON.stringify({ key, options, createdAt: new Date().toISOString() }, null, 2));
    return { uploadId, key };
  }

  async getSignedUploadUrl(): Promise<string> {
    throw new Error('The local storage driver has no presigned part URLs: parts go through PUT /api/storage/objects/:id/upload/parts/:n.');
  }

  async uploadPart(_key: string, uploadId: string, partNumber: number, body: Readable, size: number): Promise<StoredPart> {
    const dir = this.partsDir(uploadId);
    if (!fs.existsSync(dir)) throw new MultipartSessionNotFoundError(uploadId);
    const finalPath = this.partFile(uploadId, partNumber);
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    const meter = new PartMeter(size);
    try {
      await pipeline(body, meter, fs.createWriteStream(tmpPath));
    } catch (error) {
      await rm(tmpPath, { force: true });
      if (meter.exceeded) throw new PartSizeMismatchError(partNumber, size, meter.bytes, true);
      throw error;
    }
    if (meter.bytes !== size) {
      await rm(tmpPath, { force: true });
      throw new PartSizeMismatchError(partNumber, size, meter.bytes, false);
    }
    await rename(tmpPath, finalPath);
    return { eTag: `"${meter.hash.digest('hex')}"` };
  }

  async listUploadedParts(_key: string, uploadId: string): Promise<UploadedPart[]> {
    const dir = this.partsDir(uploadId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      throw new MultipartSessionNotFoundError(uploadId);
    }
    const parts: UploadedPart[] = [];
    for (const name of names) {
      const match = /^part-(\d+)$/.exec(name);
      if (!match) continue;
      const file = path.join(dir, name);
      const info = await stat(file);
      const hash = createHash('md5');
      await pipeline(fs.createReadStream(file), new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          cb();
        },
      }));
      parts.push({ partNumber: Number(match[1]), size: info.size, eTag: `"${hash.digest('hex')}"` });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<StorageUploadResult> {
    const dir = this.partsDir(uploadId);
    if (!fs.existsSync(dir)) throw new MultipartSessionNotFoundError(uploadId);
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const missing = sortedParts
      .filter((part) => !fs.existsSync(this.partFile(uploadId, part.partNumber)))
      .map((part) => part.partNumber);
    if (missing.length > 0) throw new MultipartPartsMissingError(missing);

    const fullPath = this.pathOf(key);
    await mkdir(path.dirname(fullPath), { recursive: true });
    const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
    const writeStream = fs.createWriteStream(tmpPath);
    const corrupt: number[] = [];
    try {
      for (const part of sortedParts) {
        const hash = createHash('md5');
        const hasher = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(fs.createReadStream(this.partFile(uploadId, part.partNumber)), hasher, writeStream, { end: false });
        if (hash.digest('hex') !== normalizeETag(part.eTag)) corrupt.push(part.partNumber);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (error) {
      writeStream.destroy();
      await rm(tmpPath, { force: true });
      throw error;
    }
    if (corrupt.length > 0) {
      await rm(tmpPath, { force: true });
      // A part whose bytes no longer match the ETag the client was given is
      // dropped, so `listUploadedParts` (and the upload status) stops reporting
      // it and a resuming client re-sends exactly those parts.
      for (const partNumber of corrupt) await rm(this.partFile(uploadId, partNumber), { force: true });
      throw new MultipartPartsMissingError(corrupt);
    }
    await rename(tmpPath, fullPath);
    let mimeType = 'application/octet-stream';
    try {
      const init = JSON.parse(await readFile(path.join(dir, '.init.json'), 'utf-8')) as { options?: StorageUploadOptions };
      if (init.options?.mimeType) mimeType = init.options.mimeType;
    } catch {
      /* the init marker is advisory */
    }
    await writeFile(
      this.sidecarPath(fullPath),
      JSON.stringify({ mimeType, metadata: {}, size: (await stat(fullPath)).size, createdAt: new Date().toISOString() }, null, 2),
    );
    await rm(dir, { recursive: true, force: true });
    return { key, bucket: this.getBucket(), location: fullPath };
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    await rm(this.partsDir(uploadId), { recursive: true, force: true });
  }

  /** Every key under `prefix` (the purge lister). Skips sidecars, temp files and open uploads. */
  async *listKeys(prefix: string): AsyncIterable<string> {
    const start = path.join(this.root, prefix);
    const walk = async function* (dir: string, root: string): AsyncIterable<string> {
      let entries: fs.Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.multipart') continue;
          yield* walk(full, root);
        } else if (entry.isFile() && !entry.name.endsWith('.meta.json') && !entry.name.endsWith('.tmp')) {
          yield path.relative(root, full).split(path.sep).join('/');
        }
      }
    };
    const dir = prefix.endsWith('/') ? start : path.dirname(start);
    for await (const key of walk(dir, this.root)) {
      if (key.startsWith(prefix)) yield key;
    }
  }
}

// ---- the driver ---------------------------------------------------------------------

async function testLocalRoot(root: string): Promise<StorageDriverTestResult> {
  const probe = path.join(root, '.memoriahub-probe', randomUUID());
  try {
    await mkdir(path.dirname(probe), { recursive: true });
    await writeFile(probe, 'probe');
    const read = await readFile(probe, 'utf-8');
    await rm(path.dirname(probe), { recursive: true, force: true });
    if (read !== 'probe') return { ok: false, message: `The folder ${root} did not read back what was written.` };
    let free: number | undefined;
    try {
      const info = await statfs(root);
      free = Number(info.bavail) * Number(info.bsize);
    } catch {
      /* free space is informational */
    }
    return {
      ok: true,
      message: `Wrote, read and deleted a probe file under ${root}.`,
      details: { rootDir: root, ...(free !== undefined ? { freeBytes: free } : {}) },
    };
  } catch (error) {
    return { ok: false, message: `The folder ${root} is not writable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The `local` driver definition, registered by `app-registrations/storage.ts`. */
export const localStorageDriver: StorageDriverDefinition<LocalSettings> = {
  id: LOCAL_DRIVER_ID,
  label: 'Local disk',
  description:
    'Objects as files in a folder on the API host. Resumable uploads stream through the API; downloads are short-lived signed links to the API.',
  settingsSchema: localSettingsSchema,
  defaults: { rootDir: '' },
  secrets: [],
  build: (ctx) => new LocalDiskStorageProvider(resolveLocalRootDir(ctx.settings), ctx.appOrigin ?? ''),
  testConnection: (ctx) => testLocalRoot(resolveLocalRootDir(ctx.settings)),
  location: (settings) => ({ bucket: path.basename(resolveLocalRootDir(settings)) || 'local-backup' }),
  missing: () => [],
  async *listKeys(ctx, prefix) {
    yield* new LocalDiskStorageProvider(resolveLocalRootDir(ctx.settings)).listKeys(prefix);
  },
};
