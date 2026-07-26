/**
 * test/commands/screenshots.spec.ts — Unit tests for the `screenshots` command.
 *
 * Mirrors test/commands/organize.spec.ts and, for the mutual-exclusivity
 * guard, the pattern used in test/commands/convert.spec.ts for
 * --delete-original/--move-originals-to.
 *
 * Tests:
 *   - No folder args and no --all → warns + exits 1, engine never constructed
 *   - --move-to and --delete together → ui.error + exit(1), engine never
 *     constructed (resolveMode's own guard, checked before getDb())
 *   - --all --dry-run --json → JSON summary printed to stdout, no exit call
 *   - Engine rejection → ui.error + exit(1)
 *   - --move-to alone → engine constructed and run() called with mode:'move'
 *     and destDir resolved to an absolute path
 *
 * Mocking strategy: jest.unstable_mockModule for db/database.js, ui.js, and
 * screenshots/screenshot-engine.js (so no real filesystem walk happens).
 * process.exit is intercepted to throw, matching test/commands/organize.spec.ts.
 */

import { jest } from '@jest/globals';
import * as path from 'path';

process.env['NO_COLOR'] = '1';

// ---------------------------------------------------------------------------
// Intercept process.exit so Jest does not actually exit
// ---------------------------------------------------------------------------
const mockExit = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
  throw new Error(`process.exit(${String(_code)})`);
});

// ---------------------------------------------------------------------------
// Mock db/database.js — getDb() must not touch the real singleton sqlite file.
// ---------------------------------------------------------------------------
const mockGetDb = jest.fn(() => ({}) as any);

jest.unstable_mockModule('../../src/db/database.js', () => ({
  getDb: mockGetDb,
  openDb: jest.fn(),
  closeDb: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ui.js
// ---------------------------------------------------------------------------
const mockUiWarn = jest.fn();
const mockUiInfo = jest.fn();
const mockUiError = jest.fn();
const mockUiSuccess = jest.fn();
const mockSpinner = {
  start: jest.fn(),
  succeed: jest.fn(),
  fail: jest.fn(),
  text: '',
};
const mockCreateSpinner = jest.fn(() => mockSpinner);

jest.unstable_mockModule('../../src/ui.js', () => ({
  ui: { warn: mockUiWarn, info: mockUiInfo, error: mockUiError, success: mockUiSuccess },
  createSpinner: mockCreateSpinner,
  isTTY: false,
  printBox: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock screenshots/screenshot-engine.js — no real filesystem walk.
// ---------------------------------------------------------------------------
const mockEngineOn = jest.fn();
const mockEngineRun = jest.fn<() => Promise<{ totals: unknown; matches: unknown[] }>>();
const MockScreenshotEngine = jest.fn().mockImplementation(() => ({
  on: mockEngineOn,
  run: mockEngineRun,
}));

jest.unstable_mockModule('../../src/screenshots/screenshot-engine.js', () => ({
  ScreenshotEngine: MockScreenshotEngine,
}));

// Dynamic import AFTER all unstable_mockModule calls
const { screenshotsCommand } = await import('../../src/commands/screenshots.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleTotals(): {
  matched: number;
  bytes: number;
  moved: number;
  deleted: number;
  skipped: number;
  errors: number;
} {
  return {
    matched: 3,
    bytes: 12345,
    moved: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
  };
}

async function invokeScreenshots(args: string[]): Promise<void> {
  const cmd = screenshotsCommand();
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('screenshots command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  describe('no folder args and no --all', () => {
    it('warns, informs, and exits 1 without constructing the engine', async () => {
      await expect(invokeScreenshots([])).rejects.toThrow('process.exit(1)');

      expect(mockUiWarn).toHaveBeenCalledWith(expect.stringContaining('No folders specified'));
      expect(mockUiInfo).toHaveBeenCalled();
      expect(MockScreenshotEngine).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('--move-to and --delete together', () => {
    it('reports the mutual-exclusivity error via ui.error and exits 1 without constructing the engine', async () => {
      await expect(
        invokeScreenshots(['--all', '--move-to', 'somewhere', '--delete']),
      ).rejects.toThrow('process.exit(1)');

      expect(mockUiError).toHaveBeenCalledWith('Choose only one of --move-to or --delete.');
      expect(MockScreenshotEngine).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('--all --dry-run --json', () => {
    it('prints the totals as JSON to stdout and does not call process.exit', async () => {
      const totals = sampleTotals();
      mockEngineRun.mockResolvedValue({ totals, matches: [] });

      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await invokeScreenshots(['--all', '--dry-run', '--json']);

      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(printed) as { totals: ReturnType<typeof sampleTotals> };
      expect(parsed.totals).toEqual(totals);

      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({ all: true, dryRun: true, mode: 'find' }),
      );
      // JSON mode must not create a spinner (keeps stdout clean for scripting).
      expect(mockCreateSpinner).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });
  });

  describe('engine rejection', () => {
    it('reports the error via ui.error and exits 1', async () => {
      mockEngineRun.mockRejectedValue(
        new Error('No target folders specified. Pass folder paths, folder IDs, or --all.'),
      );

      await expect(invokeScreenshots(['--all', '--json'])).rejects.toThrow('process.exit(1)');

      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('No target folders specified'),
      );
    });
  });

  describe('--move-to alone', () => {
    it('constructs the engine and calls run() with mode:"move" and an absolute destDir', async () => {
      mockEngineRun.mockResolvedValue({ totals: sampleTotals(), matches: [] });

      await invokeScreenshots(['--all', '--json', '--move-to', 'my-screenshots']);

      expect(MockScreenshotEngine).toHaveBeenCalledTimes(1);
      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'move',
          destDir: path.resolve('my-screenshots'),
        }),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });
});

// Suppress unused import warning
void jest;
