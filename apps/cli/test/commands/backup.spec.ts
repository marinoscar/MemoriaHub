/**
 * test/commands/backup.spec.ts — Unit tests for the `backup` command.
 *
 * Tests the validation and download logic in isolation:
 *   - Missing --circle and --all → error + exit(1)
 *   - --circle <id> --dest /tmp/x → calls listBackupObjects(circleId)
 *   - --all --dest /tmp/x → calls listBackupObjects(undefined)
 *   - ApiClient error → error + exit(1)
 *   - Successful download writes files to dest directory
 *   - Skips existing files with matching size
 *
 * Mocking strategy:
 *   - jest.unstable_mockModule for config and ApiClient (ESM)
 *   - global.fetch mocked for download HTTP calls
 *   - process.exit intercepted to throw (prevents Jest from exiting)
 *   - fs operations use a real temp dir cleaned up after each test
 *   - Commander commands invoked via parseAsync with fake argv
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Capture process.exit so Jest does not actually exit
// ---------------------------------------------------------------------------
const mockExit = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
  throw new Error(`process.exit(${String(_code)})`);
});

// ---------------------------------------------------------------------------
// Fake fetch for download requests
// ---------------------------------------------------------------------------
const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Mock config module
// ---------------------------------------------------------------------------
const mockRequireConfig = jest.fn(() => ({
  serverUrl: 'http://test-server',
  pat: 'test-pat',
}));

jest.unstable_mockModule('../../src/config.js', () => ({
  requireConfig: mockRequireConfig,
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ApiClient
// ---------------------------------------------------------------------------
const mockListBackupObjects = jest.fn<() => Promise<{ items: Array<{
  mediaItemId: string;
  storageKey: string;
  downloadUrl: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  circleId: string;
}> }>>();

jest.unstable_mockModule('../../src/api.js', () => {
  const ApiClient = jest.fn().mockImplementation(() => ({
    listBackupObjects: mockListBackupObjects,
  }));
  return {
    ApiClient,
    ApiError: class ApiError extends Error {
      public status: number;
      public serverMessage: string;
      constructor(status: number, serverMessage: string) {
        super(`API error ${status}: ${serverMessage}`);
        this.name = 'ApiError';
        this.status = status;
        this.serverMessage = serverMessage;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Suppress chalk/ui color output in tests
// ---------------------------------------------------------------------------
process.env['NO_COLOR'] = '1';

// Dynamic import AFTER all unstable_mockModule calls
const { backupCommand } = await import('../../src/commands/backup.js');

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeSampleItem(overrides: Partial<{
  mediaItemId: string;
  storageKey: string;
  downloadUrl: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  circleId: string;
}> = {}) {
  return {
    mediaItemId: 'media-1',
    storageKey: 'photos/circle-a/file.jpg',
    downloadUrl: 'https://cdn.example.com/signed-url/file.jpg',
    originalFilename: 'file.jpg',
    mimeType: 'image/jpeg',
    size: 11, // matches 'image bytes'
    circleId: 'circle-a',
    ...overrides,
  };
}

function makeFakeResponse(body: string, ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok,
    status,
    body: stream,
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Run the backup command as if invoked from the CLI.
 * commander.parseAsync expects `process.argv`-style array:
 *   [node, script, ...args]
 */
async function invokeBackup(args: string[]): Promise<void> {
  const cmd = backupCommand();
  // Allow parseAsync to exit on unknown options without throwing by default;
  // we intercept process.exit above so it throws instead.
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backup command', () => {
  let tmpDest: string;

  beforeEach(() => {
    tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cmd-test-'));
    jest.clearAllMocks();
    mockRequireConfig.mockReturnValue({ serverUrl: 'http://test-server', pat: 'test-pat' });
  });

  afterEach(() => {
    fs.rmSync(tmpDest, { recursive: true, force: true });
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  describe('validation — missing required options', () => {
    it('exits with 1 when neither --circle nor --all is provided', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      await expect(
        invokeBackup(['--dest', tmpDest]),
      ).rejects.toThrow('process.exit(1)');

      expect(mockListBackupObjects).not.toHaveBeenCalled();
    });
  });

  describe('--all flag', () => {
    it('calls listBackupObjects with no circleId when --all is used', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      // will exit(0) for empty list — catch it
      await invokeBackup(['--all', '--dest', tmpDest]).catch(() => {});

      expect(mockListBackupObjects).toHaveBeenCalledWith(undefined);
    });

    it('exits 0 when item list is empty', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      await expect(
        invokeBackup(['--all', '--dest', tmpDest]),
      ).rejects.toThrow('process.exit(0)');
    });
  });

  describe('--circle flag', () => {
    it('calls listBackupObjects(circleId) when --circle is used', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      await invokeBackup(['--circle', 'circle-abc', '--dest', tmpDest]).catch(() => {});

      expect(mockListBackupObjects).toHaveBeenCalledWith('circle-abc');
    });

    it('passes the exact circle id, not undefined', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      await invokeBackup(['--circle', 'circle-xyz', '--dest', tmpDest]).catch(() => {});

      const [calledCircleId] = mockListBackupObjects.mock.calls[0]!;
      expect(calledCircleId).toBe('circle-xyz');
    });
  });

  describe('download flow', () => {
    it('downloads each item and writes it to dest/<circleId>/<storageKey>', async () => {
      const item = makeSampleItem();
      mockListBackupObjects.mockResolvedValue({ items: [item] });
      mockFetch.mockResolvedValue(makeFakeResponse('image bytes'));

      await invokeBackup(['--all', '--dest', tmpDest]);

      const expectedPath = path.join(tmpDest, item.circleId, item.storageKey);
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    it('skips a file that already exists with matching size', async () => {
      const item = makeSampleItem({ size: 11 }); // 'image bytes' = 11 bytes
      const expectedPath = path.join(tmpDest, item.circleId, item.storageKey);
      fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
      fs.writeFileSync(expectedPath, 'image bytes'); // 11 bytes

      mockListBackupObjects.mockResolvedValue({ items: [item] });
      // fetch should NOT be called for a skipped file
      mockFetch.mockResolvedValue(makeFakeResponse('image bytes'));

      await invokeBackup(['--all', '--dest', tmpDest]);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('downloads items for multiple circles into separate subdirectories', async () => {
      const item1 = makeSampleItem({
        mediaItemId: 'm1',
        circleId: 'circle-a',
        storageKey: 'photos/circle-a/a.jpg',
        downloadUrl: 'https://cdn.example.com/a.jpg',
        size: 6,
      });
      const item2 = makeSampleItem({
        mediaItemId: 'm2',
        circleId: 'circle-b',
        storageKey: 'photos/circle-b/b.jpg',
        downloadUrl: 'https://cdn.example.com/b.jpg',
        size: 7,
      });
      mockListBackupObjects.mockResolvedValue({ items: [item1, item2] });
      mockFetch
        .mockResolvedValueOnce(makeFakeResponse('bytes-a'))
        .mockResolvedValueOnce(makeFakeResponse('bytes-bb'));

      await invokeBackup(['--all', '--dest', tmpDest]);

      expect(fs.existsSync(path.join(tmpDest, 'circle-a', 'photos/circle-a/a.jpg'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDest, 'circle-b', 'photos/circle-b/b.jpg'))).toBe(true);
    });
  });

  describe('API error handling', () => {
    it('exits with 1 when listBackupObjects throws', async () => {
      mockListBackupObjects.mockRejectedValue(new Error('403 Forbidden'));

      await expect(
        invokeBackup(['--all', '--dest', tmpDest]),
      ).rejects.toThrow('process.exit(1)');
    });

    it('exits with 1 when download fetch returns non-ok status (all items fail)', async () => {
      const item = makeSampleItem({ size: 99999 }); // size mismatch ensures no skip
      mockListBackupObjects.mockResolvedValue({ items: [item] });
      mockFetch.mockResolvedValue(makeFakeResponse('Forbidden', false, 403));

      await expect(
        invokeBackup(['--all', '--dest', tmpDest]),
      ).rejects.toThrow('process.exit(1)');
    });
  });

  describe('config usage', () => {
    it('calls requireConfig to get server credentials', async () => {
      mockListBackupObjects.mockResolvedValue({ items: [] });

      await invokeBackup(['--all', '--dest', tmpDest]).catch(() => {});

      expect(mockRequireConfig).toHaveBeenCalled();
    });
  });
});

// Suppress unused import warning for jest
void jest;
