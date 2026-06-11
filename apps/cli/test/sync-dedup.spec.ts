/**
 * Integration test — dedup skip on repeat sync (Step 11 acceptance criterion).
 *
 * Scenario:
 *   1. First sync: files are new, server returns empty dedup list → upload + register
 *   2. Second sync on the SAME unchanged folder:
 *      - Sync command checks manifest (status=uploaded, sha256 matches) → skip
 *      - upload/init is NEVER called on the second run
 *
 * This test exercises the full data path:
 *   enumerateFiles → manifest check (sha256File) → processFiles → saveManifest → loadManifest
 *
 * Mocking strategy:
 *   - global.fetch is replaced with jest.spyOn so all HTTP calls are intercepted.
 *   - os.homedir() is overridden via jest.unstable_mockModule (ESM-safe) so no
 *     ~/.memoriahub is touched.
 *   - cli-progress is module-mocked to suppress terminal output.
 *
 * The sync command action is tightly coupled to Commander + requireConfig().
 * We call the lower-level exported functions directly (same logic as the action)
 * to keep the test hermetic and fast.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

// ---- os.homedir isolation ----
// Under ESM with --experimental-vm-modules, jest.mock() does not intercept
// static imports of built-in modules. We use jest.unstable_mockModule instead.

let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => _fakeHome || actualOs.homedir()),
}));

// ---- Suppress cli-progress terminal output ----
jest.mock('cli-progress', () => ({
  SingleBar: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    update: jest.fn(),
    stop: jest.fn(),
  })),
  Presets: { shades_classic: {} },
}));

// Dynamic imports AFTER jest.unstable_mockModule so the mock is applied
const { enumerateFiles } = await import('../src/files.js');
const { loadManifest, saveManifest } = await import('../src/manifest.js');
const { processFiles } = await import('../src/process-files.js');
const { ApiClient } = await import('../src/api.js');
const { sha256File } = await import('../src/hash.js');

// ---- Server mock factory ----

interface CallRecord {
  url: string;
  method: string;
}

/**
 * Build a fetch mock that routes requests by URL + method.
 * Appends every call to the provided callLog for assertions.
 */
function buildFetchMock(
  knownHashes: Set<string>,
  callLog: CallRecord[],
): jest.MockedFunction<typeof fetch> {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(input);
    const method = init?.method ?? 'GET';
    callLog.push({ url: urlStr, method });

    // GET /api/auth/me
    if (urlStr.includes('/api/auth/me') && method === 'GET') {
      return new Response(
        JSON.stringify({ data: { id: 'user-1', email: 'test@example.com' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /api/media?contentHash=...  — dedup check
    if (urlStr.includes('/api/media?contentHash=') && method === 'GET') {
      const hashParam = new URL(urlStr).searchParams.get('contentHash') ?? '';
      const items = knownHashes.has(hashParam)
        ? [{ id: 'server-media-id', contentHash: hashParam }]
        : [];
      return new Response(
        JSON.stringify({ data: { items } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /api/storage/objects/upload/init
    if (urlStr.includes('/upload/init') && method === 'POST') {
      return new Response(
        JSON.stringify({
          data: {
            objectId: `obj-${Date.now()}`,
            uploadId: `upload-${Date.now()}`,
            partSize: 5 * 1024 * 1024,
            totalParts: 1,
            presignedUrls: [{ partNumber: 1, url: 'https://s3.fake/presigned/part1' }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // PUT presigned S3 URL
    if (urlStr.startsWith('https://s3.fake/') && method === 'PUT') {
      return new Response('', {
        status: 200,
        headers: { ETag: '"etag-test-001"' },
      });
    }

    // POST .../upload/part-urls
    if (urlStr.includes('/upload/part-urls') && method === 'POST') {
      return new Response(
        JSON.stringify({ data: { presignedUrls: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST .../upload/complete
    if (urlStr.includes('/upload/complete') && method === 'POST') {
      return new Response(
        JSON.stringify({ data: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // POST /api/media  — register media item
    if (urlStr.endsWith('/api/media') && method === 'POST') {
      return new Response(
        JSON.stringify({ data: { id: `media-${Date.now()}` } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    throw new Error(`[sync-dedup test] Unhandled fetch: ${method} ${urlStr}`);
  }) as unknown as jest.MockedFunction<typeof fetch>;
}

// ---- Sync flow helper ----
// Mirrors the sync command action without Commander / requireConfig().
async function runSync(
  folderPath: string,
  api: InstanceType<typeof ApiClient>,
): Promise<{ skippedByManifest: number; processedCount: number }> {
  const absFolder = path.resolve(folderPath);
  const { supported } = enumerateFiles(absFolder, false);

  const manifest = loadManifest(absFolder);
  manifest.folderPath = absFolder;

  const toProcess: Array<{ filePath: string; mimeType: string }> = [];
  let alreadySynced = 0;

  for (const { filePath, mimeType } of supported) {
    const entry = manifest.files[filePath];
    if (entry?.status === 'uploaded') {
      let currentHash: string;
      try {
        currentHash = await sha256File(filePath);
      } catch {
        toProcess.push({ filePath, mimeType });
        continue;
      }
      if (currentHash === entry.sha256) {
        alreadySynced++;
        continue;
      }
    }
    toProcess.push({ filePath, mimeType });
  }

  if (toProcess.length > 0) {
    await processFiles({
      filePaths: toProcess,
      api,
      manifest,
      dryRun: false,
    });
  }

  manifest.lastSyncAt = new Date().toISOString();
  saveManifest(absFolder, manifest);

  return { skippedByManifest: alreadySynced, processedCount: toProcess.length };
}

// ---- Test suite ----

describe('sync dedup integration — second sync skips unchanged files', () => {
  let tmpHome: string;
  let tmpPhotos: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-sync-home-'));
    _fakeHome = tmpHome;

    tmpPhotos = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-sync-photos-'));
    fs.writeFileSync(path.join(tmpPhotos, 'photo1.jpg'), Buffer.from('fake-jpeg-content-1'));
    fs.writeFileSync(path.join(tmpPhotos, 'photo2.jpg'), Buffer.from('fake-jpeg-content-2'));
  });

  afterEach(() => {
    _fakeHome = '';
    if (fetchSpy) fetchSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpPhotos, { recursive: true, force: true });
  });

  it('uploads files on first sync and skips ALL files on second sync (THE acceptance criterion)', async () => {
    const api = new ApiClient({ serverUrl: 'http://fake.local', pat: 'test-pat' });
    const serverKnownHashes = new Set<string>();
    const callLog: CallRecord[] = [];

    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      buildFetchMock(serverKnownHashes, callLog),
    );

    // --- FIRST RUN ---
    const run1 = await runSync(tmpPhotos, api);

    // Both files should have been processed (not yet in manifest)
    expect(run1.processedCount).toBe(2);
    expect(run1.skippedByManifest).toBe(0);

    // upload/init should have been called once per file
    const initCallsRun1 = callLog.filter((c) => c.url.includes('/upload/init'));
    expect(initCallsRun1).toHaveLength(2);

    // Manifest should record both files as uploaded with sha256
    const manifest1 = loadManifest(tmpPhotos);
    const entries = Object.values(manifest1.files);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.status).toBe('uploaded');
      expect(entry.sha256).toBeTruthy();
    }

    // Clear call log before second run
    callLog.length = 0;

    // --- SECOND RUN (no file changes) ---
    const run2 = await runSync(tmpPhotos, api);

    // Both files should be skipped by the manifest+sha256 check BEFORE processFiles
    expect(run2.skippedByManifest).toBe(2);
    expect(run2.processedCount).toBe(0);

    // CRITICAL: zero upload/init calls on the second run
    const initCallsRun2 = callLog.filter((c) => c.url.includes('/upload/init'));
    expect(initCallsRun2).toHaveLength(0);

    // Also no media registration calls
    const registerCallsRun2 = callLog.filter(
      (c) => c.url.endsWith('/api/media') && c.method === 'POST',
    );
    expect(registerCallsRun2).toHaveLength(0);

    // And no dedup-check API calls either (we skip before even calling processFiles)
    const dedupCallsRun2 = callLog.filter((c) => c.url.includes('/api/media?contentHash='));
    expect(dedupCallsRun2).toHaveLength(0);
  });

  it('re-uploads a file that has changed between syncs', async () => {
    const api = new ApiClient({ serverUrl: 'http://fake.local', pat: 'test-pat' });
    const serverKnownHashes = new Set<string>();
    const callLog: CallRecord[] = [];

    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      buildFetchMock(serverKnownHashes, callLog),
    );

    // First sync
    await runSync(tmpPhotos, api);
    callLog.length = 0;

    // Modify one file
    fs.writeFileSync(path.join(tmpPhotos, 'photo1.jpg'), Buffer.from('UPDATED-content-new'));

    // Second sync — only the changed file should be re-uploaded
    const run2 = await runSync(tmpPhotos, api);

    // photo2.jpg unchanged → skipped; photo1.jpg changed → processed
    expect(run2.skippedByManifest).toBe(1);
    expect(run2.processedCount).toBe(1);

    const initCalls = callLog.filter((c) => c.url.includes('/upload/init'));
    expect(initCalls).toHaveLength(1);
  });

  it('retries failed files on second sync without re-uploading successful ones', async () => {
    const api = new ApiClient({ serverUrl: 'http://fake.local', pat: 'test-pat' });
    const callLog: CallRecord[] = [];

    // On first run, let the register call fail for photo1 (first POST /api/media)
    let registerCallCount = 0;

    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = String(input);
        const method = init?.method ?? 'GET';
        callLog.push({ url: urlStr, method });

        if (urlStr.includes('/api/media?contentHash=') && method === 'GET') {
          return new Response(
            JSON.stringify({ data: { items: [] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.includes('/upload/init') && method === 'POST') {
          return new Response(
            JSON.stringify({
              data: {
                objectId: `obj-${Date.now()}`,
                uploadId: 'upload-x',
                partSize: 5 * 1024 * 1024,
                totalParts: 1,
                presignedUrls: [{ partNumber: 1, url: 'https://s3.fake/p1' }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.startsWith('https://s3.fake/') && method === 'PUT') {
          return new Response('', { status: 200, headers: { ETag: '"e1"' } });
        }
        if (urlStr.includes('/upload/complete') && method === 'POST') {
          return new Response(JSON.stringify({ data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // POST /api/media — fail the very first registration
        if (urlStr.endsWith('/api/media') && method === 'POST') {
          registerCallCount++;
          if (registerCallCount === 1) {
            return new Response(JSON.stringify({ message: 'Internal error' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ data: { id: `media-${registerCallCount}` } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unhandled: ${method} ${urlStr}`);
      },
    );

    // First run: first registered file fails, second succeeds
    await runSync(tmpPhotos, api);

    const manifest1 = loadManifest(tmpPhotos);
    // Exactly one uploaded, one failed
    const statuses = Object.values(manifest1.files).map((e) => e.status);
    expect(statuses).toContain('uploaded');
    expect(statuses).toContain('failed');

    callLog.length = 0;

    // Second run: the uploaded file is skipped by manifest; the failed file is retried
    const run2 = await runSync(tmpPhotos, api);

    expect(run2.skippedByManifest).toBe(1);
    expect(run2.processedCount).toBe(1);

    // Exactly 1 upload/init for the retried file
    const initCalls = callLog.filter((c) => c.url.includes('/upload/init'));
    expect(initCalls).toHaveLength(1);
  });
});
