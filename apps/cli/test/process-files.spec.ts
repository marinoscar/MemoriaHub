/**
 * Unit tests for the dedup-check logic inside processFiles().
 *
 * processFiles() is the core loop in src/process-files.ts. It:
 *   1. Computes SHA-256 of each file
 *   2. Calls GET /api/media?contentHash=<h> to dedup-check
 *   3. If the server already has the file (non-empty items) → skip (no upload)
 *   4. If not → upload via uploadFile() + register via POST /api/media
 *
 * We mock at the global.fetch seam because ApiClient uses it directly.
 * We also mock cli-progress to suppress terminal output in tests.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processFiles, ProcessOptions, ProcessResult } from '../src/process-files.js';
import { ApiClient } from '../src/api.js';
import { Manifest } from '../src/manifest.js';

// ---- Silence cli-progress in tests ----
jest.mock('cli-progress', () => {
  return {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(),
      update: jest.fn(),
      stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  };
});

// ---- Helpers ----

function makeManifest(folderPath: string): Manifest {
  return {
    folderPath,
    lastSyncAt: null,
    files: {},
  };
}

function makeApiClient(): ApiClient {
  return new ApiClient({ serverUrl: 'http://fake.local', pat: 'test-pat' });
}

function writeTempJpeg(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])); // minimal JPEG header
  return p;
}

// ---- Tests ----

describe('processFiles — dedup-check logic', () => {
  let tmpDir: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-pf-test-'));
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('when the server already has the file (non-empty items array)', () => {
    it('does NOT call upload/init and records the existing mediaItemId in the manifest', async () => {
      const filePath = writeTempJpeg(tmpDir, 'photo.jpg');
      const manifest = makeManifest(tmpDir);

      // GET /api/media?contentHash=... → file already exists
      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/media?contentHash=')) {
          return new Response(
            JSON.stringify({ data: { items: [{ id: 'existing-media-id', contentHash: 'irrelevant' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      });

      const opts: ProcessOptions = {
        filePaths: [{ filePath, mimeType: 'image/jpeg' }],
        api: makeApiClient(),
        manifest,
        dryRun: false,
      };

      const result: ProcessResult = await processFiles(opts);

      // File should be counted as skipped (dedup match)
      expect(result.skipped).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(result.failed).toBe(0);

      // Manifest should record the existing mediaItemId
      expect(manifest.files[filePath]).toBeDefined();
      expect(manifest.files[filePath].mediaItemId).toBe('existing-media-id');
      expect(manifest.files[filePath].status).toBe('uploaded');

      // upload/init must NOT have been called
      const uploadInitCalled = fetchSpy.mock.calls.some(([u]) =>
        String(u).includes('/upload/init'),
      );
      expect(uploadInitCalled).toBe(false);
    });

    it('skips multiple files when all are deduplicated', async () => {
      const fileA = writeTempJpeg(tmpDir, 'a.jpg');
      const fileB = writeTempJpeg(tmpDir, 'b.jpg');
      const manifest = makeManifest(tmpDir);

      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/media?contentHash=')) {
          return new Response(
            JSON.stringify({ data: { items: [{ id: 'media-abc', contentHash: 'h' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      });

      const opts: ProcessOptions = {
        filePaths: [
          { filePath: fileA, mimeType: 'image/jpeg' },
          { filePath: fileB, mimeType: 'image/jpeg' },
        ],
        api: makeApiClient(),
        manifest,
        dryRun: false,
      };

      const result = await processFiles(opts);

      expect(result.skipped).toBe(2);
      expect(result.uploaded).toBe(0);
    });
  });

  describe('when the server does NOT have the file (empty items array)', () => {
    it('calls upload/init and POST /api/media and records status=uploaded in manifest', async () => {
      const filePath = writeTempJpeg(tmpDir, 'new-photo.jpg');
      const manifest = makeManifest(tmpDir);

      fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const urlStr = String(url);

        // Dedup check → empty
        if (urlStr.includes('/api/media?contentHash=')) {
          return new Response(
            JSON.stringify({ data: { items: [] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Upload init
        if (urlStr.includes('/upload/init') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              data: {
                objectId: 'obj-001',
                uploadId: 'upload-001',
                partSize: 5 * 1024 * 1024,
                totalParts: 1,
                presignedUrls: [{ partNumber: 1, url: 'https://s3.fake/part1' }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // PUT presigned URL (S3)
        if (urlStr === 'https://s3.fake/part1' && init?.method === 'PUT') {
          return new Response('', {
            status: 200,
            headers: { ETag: '"etag-001"' },
          });
        }

        // Upload complete
        if (urlStr.includes('/upload/complete') && init?.method === 'POST') {
          return new Response(JSON.stringify({ data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /api/media (register)
        if (urlStr.endsWith('/api/media') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ data: { id: 'new-media-id' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        throw new Error(`Unexpected fetch call: ${urlStr} [${init?.method ?? 'GET'}]`);
      });

      const opts: ProcessOptions = {
        filePaths: [{ filePath, mimeType: 'image/jpeg' }],
        api: makeApiClient(),
        manifest,
        dryRun: false,
      };

      const result = await processFiles(opts);

      expect(result.uploaded).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      // upload/init must have been called
      const initCalls = fetchSpy.mock.calls.filter(([u]) =>
        String(u).includes('/upload/init'),
      );
      expect(initCalls.length).toBe(1);

      // POST /api/media must have been called
      const registerCalls = fetchSpy.mock.calls.filter(
        ([u, i]) => String(u).endsWith('/api/media') && (i as RequestInit)?.method === 'POST',
      );
      expect(registerCalls.length).toBe(1);

      // Manifest updated
      expect(manifest.files[filePath]).toBeDefined();
      expect(manifest.files[filePath].mediaItemId).toBe('new-media-id');
      expect(manifest.files[filePath].status).toBe('uploaded');
    });
  });

  describe('dry-run mode', () => {
    it('does NOT upload when dryRun=true even if file is not deduplicated', async () => {
      const filePath = writeTempJpeg(tmpDir, 'dry.jpg');
      const manifest = makeManifest(tmpDir);

      fetchSpy.mockImplementation(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/media?contentHash=')) {
          return new Response(
            JSON.stringify({ data: { items: [] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch during dry-run: ${urlStr}`);
      });

      const opts: ProcessOptions = {
        filePaths: [{ filePath, mimeType: 'image/jpeg' }],
        api: makeApiClient(),
        manifest,
        dryRun: true,
      };

      const result = await processFiles(opts);

      expect(result.dryRunWouldUpload).toContain(filePath);
      expect(result.dryRunDedups).toHaveLength(0);

      const uploadInitCalled = fetchSpy.mock.calls.some(([u]) =>
        String(u).includes('/upload/init'),
      );
      expect(uploadInitCalled).toBe(false);
    });

    it('records dedup matches in dryRunDedups without uploading', async () => {
      const filePath = writeTempJpeg(tmpDir, 'dedup-dry.jpg');
      const manifest = makeManifest(tmpDir);

      fetchSpy.mockImplementation(async (url: unknown) => {
        if (String(url).includes('/api/media?contentHash=')) {
          return new Response(
            JSON.stringify({ data: { items: [{ id: 'existing-dry', contentHash: 'h' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

      const opts: ProcessOptions = {
        filePaths: [{ filePath, mimeType: 'image/jpeg' }],
        api: makeApiClient(),
        manifest,
        dryRun: true,
      };

      const result = await processFiles(opts);

      expect(result.dryRunDedups).toContain(filePath);
      expect(result.skipped).toBe(1);
    });
  });
});
