import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable, Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { StorageProvider } from '../storage-provider.interface';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  WrittenPart,
  WritePartOptions,
  PartSizeMismatchError,
  MultipartSessionNotFoundError,
  MultipartPartsMissingError,
} from '../storage-provider.types';

/** Strip S3-style quoting (and a weak `W/` prefix) from an ETag for comparison. */
function normalizeETag(eTag: string): string {
  return eTag.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
}

/**
 * Pass-through that hashes and counts bytes, and fails fast once more than
 * `limit` bytes have flowed — so an oversized body is cut off without ever
 * landing on disk in full, let alone in memory.
 */
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

@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
  /**
   * Local disk has no URL a remote client can PUT a part to; the API proxies
   * part uploads through {@link writePart} instead (issue #506).
   */
  readonly supportsPresignedParts = false;
  private readonly logger = new Logger(LocalDiskStorageProvider.name);
  private readonly localPath: string;

  constructor(private readonly configService: ConfigService) {
    this.localPath = this.configService.get<string>(
      'storage.backup.localPath',
      '/tmp/memoriahub-backup',
    );
    this.logger.log(`LocalDiskStorageProvider initialized - Root: ${this.localPath}`);
  }

  getBucket(): string {
    return path.basename(this.localPath) || 'local-backup';
  }

  private resolvePath(key: string): string {
    return path.join(this.localPath, key);
  }

  private sidecarPath(fullPath: string): string {
    return `${fullPath}.meta.json`;
  }

  async upload(key: string, stream: Readable, options: StorageUploadOptions): Promise<StorageUploadResult> {
    const fullPath = this.resolvePath(key);
    const dir = path.dirname(fullPath);

    fs.mkdirSync(dir, { recursive: true });

    this.logger.debug(`Uploading to local path: ${fullPath}`);

    const writeStream = fs.createWriteStream(fullPath);

    await pipeline(stream, writeStream);

    // Get actual file size
    const stat = fs.statSync(fullPath);
    const size = Number(stat.size);

    // Write sidecar metadata
    const sidecar = {
      mimeType: options.mimeType,
      metadata: options.metadata || {},
      size,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.sidecarPath(fullPath), JSON.stringify(sidecar, null, 2));

    this.logger.log(`Upload complete: ${fullPath} (${size} bytes)`);

    return { key, bucket: this.getBucket(), location: fullPath };
  }

  async download(key: string): Promise<Readable> {
    const fullPath = this.resolvePath(key);
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException(`File not found: ${key}`);
    }
    return fs.createReadStream(fullPath);
  }

  async getSignedDownloadUrl(key: string, _options?: SignedUrlOptions): Promise<string> {
    const fullPath = this.resolvePath(key);
    return `file://${fullPath}`;
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolvePath(key);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      this.logger.log(`Deleted: ${fullPath}`);
    }
    const sidecar = this.sidecarPath(fullPath);
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
    }
  }

  /**
   * Batched, best-effort delete. Loops the keys, unlinking each (and its
   * sidecar) via the same path resolution `delete` uses. Never throws for
   * individual failures — a missing file (ENOENT) counts as a success to
   * match idempotent-delete semantics; any other per-file error is collected
   * into `errors`.
   */
  async deleteMany(
    keys: string[],
  ): Promise<{ deleted: number; errors: { key: string; message: string }[] }> {
    if (keys.length === 0) {
      return { deleted: 0, errors: [] };
    }

    let deleted = 0;
    const errors: { key: string; message: string }[] = [];

    for (const key of keys) {
      try {
        // Reuse the existing single-delete path-resolution + sidecar cleanup;
        // it is already a no-op when the file is absent (idempotent).
        await this.delete(key);
        deleted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ key, message });
      }
    }

    return { deleted, errors };
  }

  async getMetadata(key: string): Promise<Record<string, string> | null> {
    const fullPath = this.resolvePath(key);
    const sidecar = this.sidecarPath(fullPath);
    if (!fs.existsSync(sidecar)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(sidecar, 'utf-8');
      const parsed = JSON.parse(raw) as { metadata?: Record<string, string> };
      return parsed.metadata || {};
    } catch {
      return null;
    }
  }

  async setMetadata(key: string, metadata: Record<string, string>): Promise<void> {
    const fullPath = this.resolvePath(key);
    const sidecar = this.sidecarPath(fullPath);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(sidecar)) {
      try {
        existing = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }
    existing['metadata'] = { ...(existing['metadata'] as Record<string, string> || {}), ...metadata };
    fs.writeFileSync(sidecar, JSON.stringify(existing, null, 2));
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolvePath(key));
  }

  async initMultipartUpload(key: string, options: StorageUploadOptions): Promise<MultipartUploadInit> {
    const uploadId = randomUUID();
    const partsDir = path.join(this.localPath, '.multipart', uploadId);
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(
      path.join(partsDir, '.init.json'),
      JSON.stringify({ key, options, createdAt: new Date().toISOString() }, null, 2),
    );
    this.logger.debug(`Multipart upload initiated: uploadId=${uploadId}, key=${key}`);
    return { uploadId, key };
  }

  /**
   * Placeholder only: local disk has no endpoint a client can PUT to. The API
   * never hands this to a client — because `supportsPresignedParts` is false it
   * returns its own part-upload route instead (issue #506).
   */
  async getSignedUploadUrl(key: string, uploadId: string, partNumber: number, _expiresIn?: number): Promise<string> {
    void key;
    return `internal://local/upload/${uploadId}/part/${partNumber}`;
  }

  private partsDir(uploadId: string): string {
    return path.join(this.localPath, '.multipart', uploadId);
  }

  private partFile(uploadId: string, partNumber: number): string {
    return path.join(this.partsDir(uploadId), `part-${partNumber}`);
  }

  /**
   * Stream one part to `.multipart/<uploadId>/part-<n>` (issue #506).
   *
   * The body goes to a uniquely named temp file first and is renamed into
   * place only once it is complete and the right size, so a retried part is
   * idempotent (the last complete write wins), two concurrent writes of the
   * same part cannot interleave, and a failed or oversized body leaves the
   * previous good copy (if any) untouched. Bytes are hashed on the way through;
   * nothing is ever buffered beyond the stream's own high-water mark.
   */
  async writePart(
    uploadId: string,
    partNumber: number,
    stream: Readable,
    options: WritePartOptions,
  ): Promise<WrittenPart> {
    const dir = this.partsDir(uploadId);
    if (!fs.existsSync(dir)) {
      throw new MultipartSessionNotFoundError(uploadId);
    }

    const finalPath = this.partFile(uploadId, partNumber);
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    const meter = new PartMeter(options.expectedSize);

    try {
      await pipeline(stream, meter, fs.createWriteStream(tmpPath));
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      if (meter.exceeded) {
        throw new PartSizeMismatchError(partNumber, options.expectedSize, meter.bytes, true);
      }
      throw error;
    }

    if (meter.bytes !== options.expectedSize) {
      fs.rmSync(tmpPath, { force: true });
      throw new PartSizeMismatchError(partNumber, options.expectedSize, meter.bytes, false);
    }

    fs.renameSync(tmpPath, finalPath);
    const eTag = `"${meter.hash.digest('hex')}"`;
    this.logger.debug(
      `Part written: uploadId=${uploadId}, part=${partNumber}, ${meter.bytes} bytes`,
    );
    return { partNumber, eTag, size: meter.bytes };
  }

  /**
   * Concatenate the listed parts into the final object.
   *
   * Refuses — and writes nothing at `key` — when any listed part file is
   * missing or its MD5 differs from the eTag the client supplied, throwing
   * {@link MultipartPartsMissingError} with every offending part number. It
   * used to skip a missing part silently, "completing" an empty or truncated
   * object (issue #506).
   *
   * The concatenation goes to a temp file next to the destination and is
   * renamed into place only after every part verified, hashing each part on the
   * same single read that copies it.
   */
  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<StorageUploadResult> {
    const partsDir = this.partsDir(uploadId);
    if (!fs.existsSync(partsDir)) {
      throw new MultipartSessionNotFoundError(uploadId);
    }

    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    // Cheap pass first, so every missing part is reported in one round-trip.
    const missing = sortedParts
      .filter((part) => !fs.existsSync(this.partFile(uploadId, part.partNumber)))
      .map((part) => part.partNumber);
    if (missing.length > 0) {
      throw new MultipartPartsMissingError(missing);
    }

    const fullPath = this.resolvePath(key);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
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
        await pipeline(
          fs.createReadStream(this.partFile(uploadId, part.partNumber)),
          hasher,
          writeStream,
          { end: false },
        );
        if (hash.digest('hex') !== normalizeETag(part.eTag)) {
          corrupt.push(part.partNumber);
        }
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (error) {
      writeStream.destroy();
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }

    if (corrupt.length > 0) {
      fs.rmSync(tmpPath, { force: true });
      throw new MultipartPartsMissingError(corrupt);
    }

    fs.renameSync(tmpPath, fullPath);

    // Cleanup parts dir only once the object is safely in place.
    fs.rmSync(partsDir, { recursive: true, force: true });

    const stat = fs.statSync(fullPath);
    this.logger.log(`Multipart upload complete: ${fullPath} (${stat.size} bytes)`);

    return { key, bucket: this.getBucket(), location: fullPath };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    void key;
    const partsDir = this.partsDir(uploadId);
    if (fs.existsSync(partsDir)) {
      fs.rmSync(partsDir, { recursive: true, force: true });
    }
    this.logger.debug(`Multipart upload aborted: uploadId=${uploadId}, key=${key}`);
  }

  /**
   * Local disk has no HTTP endpoint a remote client can PUT to, so this
   * returns a non-functional placeholder in the same style as
   * getSignedUploadUrl's `internal://` multipart-part URLs above. A real
   * distributed worker node cannot use local-disk storage for the
   * node-thumbnail-upload flow; this exists only to satisfy the interface.
   */
  async getSignedPutUrl(
    key: string,
    _options?: { contentType?: string; expiresIn?: number },
  ): Promise<string> {
    return `internal://local/upload/${encodeURIComponent(key)}`;
  }

  async getObjectSize(key: string): Promise<number | null> {
    const fullPath = this.resolvePath(key);
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    return fs.statSync(fullPath).size;
  }
}
