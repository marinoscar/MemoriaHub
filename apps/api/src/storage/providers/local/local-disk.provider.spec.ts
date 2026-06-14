import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LocalDiskStorageProvider } from './local-disk.provider';

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
});
