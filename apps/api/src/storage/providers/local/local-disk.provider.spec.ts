import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { LocalDiskStorageProvider } from './local-disk.provider';
import {
  MultipartPartsMissingError,
  MultipartSessionNotFoundError,
  PartSizeMismatchError,
} from '../storage-provider.types';

const md5 = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

/** A Readable that yields `buf` in `chunkSize` slices, never as one chunk. */
function chunked(buf: Buffer, chunkSize = 64 * 1024): Readable {
  const slices: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    slices.push(buf.subarray(i, i + chunkSize));
  }
  return Readable.from(slices);
}

describe('LocalDiskStorageProvider', () => {
  let provider: LocalDiskStorageProvider;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-disk-test-'));

    const mockConfigService = {
      get: jest.fn((key: string, def?: unknown) => {
        if (key === 'storage.backup.localPath') return tmpDir;
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalDiskStorageProvider,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    provider = module.get<LocalDiskStorageProvider>(LocalDiskStorageProvider);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('getBucket()', () => {
    it('returns the basename of the configured path', () => {
      const bucket = provider.getBucket();
      expect(bucket).toBe(path.basename(tmpDir));
    });
  });

  describe('upload()', () => {
    it('stores a file and its .meta.json sidecar; stored content matches the input stream', async () => {
      const key = 'test-file.txt';
      const content = 'hello, local disk!';
      const stream = Readable.from([content]);

      const result = await provider.upload(key, stream, {
        mimeType: 'text/plain',
        metadata: { source: 'unit-test' },
      });

      expect(result.key).toBe(key);
      expect(result.bucket).toBe(path.basename(tmpDir));

      const storedContent = fs.readFileSync(path.join(tmpDir, key), 'utf-8');
      expect(storedContent).toBe(content);

      const sidecarPath = path.join(tmpDir, `${key}.meta.json`);
      expect(fs.existsSync(sidecarPath)).toBe(true);

      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      expect(sidecar.mimeType).toBe('text/plain');
      expect(sidecar.metadata).toEqual({ source: 'unit-test' });
      expect(typeof sidecar.size).toBe('number');
      expect(typeof sidecar.createdAt).toBe('string');
    });

    it('creates parent directories for nested keys', async () => {
      const key = 'circles/abc/image.jpg';
      const stream = Readable.from(['image data']);

      await provider.upload(key, stream, { mimeType: 'image/jpeg' });

      const fullPath = path.join(tmpDir, key);
      expect(fs.existsSync(fullPath)).toBe(true);
    });

    it('writes empty metadata object when options.metadata is omitted', async () => {
      const key = 'no-meta.bin';
      const stream = Readable.from(['data']);

      await provider.upload(key, stream, { mimeType: 'application/octet-stream' });

      const sidecarPath = path.join(tmpDir, `${key}.meta.json`);
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      expect(sidecar.metadata).toEqual({});
    });
  });

  describe('download()', () => {
    it('reads back what was uploaded (round-trip)', async () => {
      const key = 'round-trip.txt';
      const content = 'round trip content';

      await provider.upload(key, Readable.from([content]), { mimeType: 'text/plain' });

      const downloadStream = await provider.download(key);

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        downloadStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        downloadStream.on('end', resolve);
        downloadStream.on('error', reject);
      });

      const result = Buffer.concat(chunks).toString('utf-8');
      expect(result).toBe(content);
    });

    it('throws NotFoundException for unknown key', async () => {
      await expect(provider.download('does-not-exist.txt')).rejects.toThrow();
    });
  });

  describe('exists()', () => {
    it('returns true for an uploaded key', async () => {
      const key = 'exists-test.txt';
      await provider.upload(key, Readable.from(['data']), { mimeType: 'text/plain' });

      expect(await provider.exists(key)).toBe(true);
    });

    it('returns false for an unknown key', async () => {
      expect(await provider.exists('no-such-file.txt')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes the file and the sidecar; exists() returns false after', async () => {
      const key = 'to-delete.txt';
      await provider.upload(key, Readable.from(['data']), { mimeType: 'text/plain' });

      expect(await provider.exists(key)).toBe(true);

      await provider.delete(key);

      expect(await provider.exists(key)).toBe(false);
      const sidecarPath = path.join(tmpDir, `${key}.meta.json`);
      expect(fs.existsSync(sidecarPath)).toBe(false);
    });

    it('does not throw when deleting a non-existent key', async () => {
      await expect(provider.delete('ghost-file.txt')).resolves.not.toThrow();
    });
  });

  describe('deleteMany()', () => {
    it('returns { deleted: 0, errors: [] } for an empty keys array', async () => {
      const result = await provider.deleteMany([]);
      expect(result).toEqual({ deleted: 0, errors: [] });
    });

    it('deletes every uploaded key (file + sidecar) and reports deleted = N', async () => {
      const keys = ['a.txt', 'b.txt', 'c.txt'];
      for (const key of keys) {
        await provider.upload(key, Readable.from(['data']), { mimeType: 'text/plain' });
      }

      const result = await provider.deleteMany(keys);

      expect(result).toEqual({ deleted: 3, errors: [] });
      for (const key of keys) {
        expect(await provider.exists(key)).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, `${key}.meta.json`))).toBe(false);
      }
    });

    it('treats a missing file (ENOENT) as a success, matching idempotent-delete semantics', async () => {
      const result = await provider.deleteMany(['never-uploaded.txt']);
      expect(result).toEqual({ deleted: 1, errors: [] });
    });

    it('a mix of existing and missing keys: all count as deleted (missing = idempotent success)', async () => {
      await provider.upload('real.txt', Readable.from(['data']), { mimeType: 'text/plain' });

      const result = await provider.deleteMany(['real.txt', 'ghost.txt']);

      expect(result).toEqual({ deleted: 2, errors: [] });
      expect(await provider.exists('real.txt')).toBe(false);
    });

    it('collects a per-file error without aborting the rest of the batch', async () => {
      await provider.upload('good.txt', Readable.from(['data']), { mimeType: 'text/plain' });
      // Make "bad.txt" a DIRECTORY, not a file — fs.unlinkSync throws a real
      // EISDIR/EPERM error on a directory, giving us a genuine per-key failure
      // without needing to mock the fs module (unlinkSync isn't spy-able here).
      fs.mkdirSync(path.join(tmpDir, 'bad.txt'));

      const result = await provider.deleteMany(['good.txt', 'bad.txt']);

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].key).toBe('bad.txt');
      expect(result.errors[0].message).toMatch(/EISDIR|EPERM|directory/i);
    });
  });

  describe('getMetadata()', () => {
    it('returns the metadata stored during upload', async () => {
      const key = 'meta-read.txt';
      const meta = { author: 'tester', version: '1' };

      await provider.upload(key, Readable.from(['content']), {
        mimeType: 'text/plain',
        metadata: meta,
      });

      const result = await provider.getMetadata(key);
      expect(result).toEqual(meta);
    });

    it('returns null for an unknown key', async () => {
      const result = await provider.getMetadata('nonexistent.txt');
      expect(result).toBeNull();
    });
  });

  describe('setMetadata()', () => {
    it('merges new fields into existing metadata sidecar', async () => {
      const key = 'meta-merge.txt';
      await provider.upload(key, Readable.from(['content']), {
        mimeType: 'text/plain',
        metadata: { existing: 'value' },
      });

      await provider.setMetadata(key, { newField: 'newValue' });

      const result = await provider.getMetadata(key);
      expect(result).toEqual({ existing: 'value', newField: 'newValue' });
    });

    it('creates sidecar if it does not exist yet', async () => {
      // Write a bare file without going through upload
      const key = 'bare-file.txt';
      const fullPath = path.join(tmpDir, key);
      fs.writeFileSync(fullPath, 'bare content');

      await provider.setMetadata(key, { tag: 'bare' });

      const result = await provider.getMetadata(key);
      expect(result).toEqual({ tag: 'bare' });
    });
  });

  describe('getSignedDownloadUrl()', () => {
    it('returns a file:// URL containing the key path', async () => {
      const key = 'some/nested/file.jpg';

      const url = await provider.getSignedDownloadUrl(key);

      expect(url).toMatch(/^file:\/\//);
      expect(url).toContain(key);
    });
  });

  // -------------------------------------------------------------------------
  // Multipart parts through the API (issue #506)
  // -------------------------------------------------------------------------
  describe('multipart parts (issue #506)', () => {
    const partA = Buffer.alloc(300 * 1024, 'a');
    const partB = Buffer.alloc(300 * 1024, 'b');
    const partC = Buffer.from('tail-bytes');

    it('declares that its part URLs are not client-reachable', () => {
      expect(provider.supportsPresignedParts).toBe(false);
    });

    it('streams a part to disk and returns the quoted MD5 as eTag', async () => {
      const { uploadId } = await provider.initMultipartUpload('big/file.bin', {
        mimeType: 'application/octet-stream',
      });

      const written = await provider.writePart(uploadId, 1, chunked(partA), {
        expectedSize: partA.length,
      });

      expect(written).toEqual({ partNumber: 1, eTag: md5(partA), size: partA.length });
      const onDisk = fs.readFileSync(path.join(tmpDir, '.multipart', uploadId, 'part-1'));
      expect(onDisk.equals(partA)).toBe(true);
      // No temp files are left behind.
      expect(fs.readdirSync(path.join(tmpDir, '.multipart', uploadId)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('is idempotent: re-sending a part replaces it', async () => {
      const { uploadId } = await provider.initMultipartUpload('k.bin', { mimeType: 'x/y' });
      const other = Buffer.alloc(partA.length, 'z');

      await provider.writePart(uploadId, 1, chunked(partA), { expectedSize: partA.length });
      const second = await provider.writePart(uploadId, 1, chunked(other), {
        expectedSize: other.length,
      });

      expect(second.eTag).toBe(md5(other));
      const onDisk = fs.readFileSync(path.join(tmpDir, '.multipart', uploadId, 'part-1'));
      expect(onDisk.equals(other)).toBe(true);
    });

    it('rejects a short part and keeps nothing', async () => {
      const { uploadId } = await provider.initMultipartUpload('k.bin', { mimeType: 'x/y' });

      await expect(
        provider.writePart(uploadId, 2, chunked(partC), { expectedSize: partC.length + 1 }),
      ).rejects.toBeInstanceOf(PartSizeMismatchError);
      expect(fs.readdirSync(path.join(tmpDir, '.multipart', uploadId))).toEqual(['.init.json']);
    });

    it('cuts off an oversized part and keeps nothing', async () => {
      const { uploadId } = await provider.initMultipartUpload('k.bin', { mimeType: 'x/y' });

      const err = await provider
        .writePart(uploadId, 1, chunked(partA), { expectedSize: 1024 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PartSizeMismatchError);
      expect((err as PartSizeMismatchError).exceeded).toBe(true);
      expect(fs.readdirSync(path.join(tmpDir, '.multipart', uploadId))).toEqual(['.init.json']);
    });

    it('rejects a write to an unknown session', async () => {
      await expect(
        provider.writePart('no-such-upload', 1, chunked(partC), { expectedSize: partC.length }),
      ).rejects.toBeInstanceOf(MultipartSessionNotFoundError);
    });

    it('completes: concatenates parts in order and cleans up', async () => {
      const key = 'uploads/1/full.bin';
      const { uploadId } = await provider.initMultipartUpload(key, { mimeType: 'x/y' });
      const a = await provider.writePart(uploadId, 1, chunked(partA), { expectedSize: partA.length });
      const b = await provider.writePart(uploadId, 2, chunked(partB), { expectedSize: partB.length });
      const c = await provider.writePart(uploadId, 3, chunked(partC), { expectedSize: partC.length });

      // Deliberately out of order: the provider sorts by part number.
      await provider.completeMultipartUpload(key, uploadId, [c, a, b]);

      const result = fs.readFileSync(path.join(tmpDir, key));
      expect(result.equals(Buffer.concat([partA, partB, partC]))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.multipart', uploadId))).toBe(false);
    });

    it('accepts unquoted eTags', async () => {
      const key = 'unquoted.bin';
      const { uploadId } = await provider.initMultipartUpload(key, { mimeType: 'x/y' });
      const a = await provider.writePart(uploadId, 1, chunked(partC), { expectedSize: partC.length });

      await provider.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, eTag: a.eTag.replace(/"/g, '') },
      ]);

      expect(fs.readFileSync(path.join(tmpDir, key)).equals(partC)).toBe(true);
    });

    it('refuses to complete with missing parts, lists them, and writes no object', async () => {
      const key = 'uploads/1/missing.bin';
      const { uploadId } = await provider.initMultipartUpload(key, { mimeType: 'x/y' });
      const a = await provider.writePart(uploadId, 1, chunked(partA), { expectedSize: partA.length });

      const err = await provider
        .completeMultipartUpload(key, uploadId, [
          a,
          { partNumber: 2, eTag: md5(partB) },
          { partNumber: 3, eTag: md5(partC) },
        ])
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MultipartPartsMissingError);
      expect((err as MultipartPartsMissingError).partNumbers).toEqual([2, 3]);
      expect(fs.existsSync(path.join(tmpDir, key))).toBe(false);
      // The session survives so the client can re-send just those parts.
      expect(fs.existsSync(path.join(tmpDir, '.multipart', uploadId, 'part-1'))).toBe(true);
    });

    it('refuses to complete when a part does not match its eTag, and writes no object', async () => {
      const key = 'uploads/1/corrupt.bin';
      const { uploadId } = await provider.initMultipartUpload(key, { mimeType: 'x/y' });
      const a = await provider.writePart(uploadId, 1, chunked(partA), { expectedSize: partA.length });
      await provider.writePart(uploadId, 2, chunked(partB), { expectedSize: partB.length });

      const err = await provider
        .completeMultipartUpload(key, uploadId, [a, { partNumber: 2, eTag: md5(partA) }])
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MultipartPartsMissingError);
      expect((err as MultipartPartsMissingError).partNumbers).toEqual([2]);
      expect(fs.existsSync(path.join(tmpDir, key))).toBe(false);
      expect(fs.readdirSync(path.join(tmpDir, 'uploads', '1'))).toEqual([]);
    });

    it('refuses to complete a session that no longer exists', async () => {
      await expect(
        provider.completeMultipartUpload('k.bin', 'gone', [{ partNumber: 1, eTag: '"x"' }]),
      ).rejects.toBeInstanceOf(MultipartSessionNotFoundError);
      expect(fs.existsSync(path.join(tmpDir, 'k.bin'))).toBe(false);
    });
  });
});
