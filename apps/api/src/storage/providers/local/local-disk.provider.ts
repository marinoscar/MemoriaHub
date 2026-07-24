import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { StorageProvider } from '../storage-provider.interface';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
} from '../storage-provider.types';

@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
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

  async getSignedUploadUrl(key: string, uploadId: string, partNumber: number, _expiresIn?: number): Promise<string> {
    void key;
    return `internal://local/upload/${uploadId}/part/${partNumber}`;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<StorageUploadResult> {
    const partsDir = path.join(this.localPath, '.multipart', uploadId);
    const fullPath = this.resolvePath(key);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    // Sort parts by part number and concat
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const writeStream = fs.createWriteStream(fullPath);

    for (const part of sortedParts) {
      const partFile = path.join(partsDir, `part-${part.partNumber}`);
      if (fs.existsSync(partFile)) {
        const partStream = fs.createReadStream(partFile);
        await pipeline(partStream, writeStream, { end: false });
      }
    }
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Cleanup parts dir
    fs.rmSync(partsDir, { recursive: true, force: true });

    const stat = fs.statSync(fullPath);
    this.logger.log(`Multipart upload complete: ${fullPath} (${stat.size} bytes)`);

    return { key, bucket: this.getBucket(), location: fullPath };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    void key;
    const partsDir = path.join(this.localPath, '.multipart', uploadId);
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
