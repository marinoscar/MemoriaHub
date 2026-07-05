/**
 * test/commands/organize.spec.ts — Unit tests for the `organize` command.
 *
 * Tests:
 *   - No folder args and no --all → warns + exits 1, engine never constructed
 *   - --all --dry-run --json → JSON summary printed to stdout, no exit call
 *   - Engine rejection → ui.error + exit(1)
 *
 * Mocking strategy: jest.unstable_mockModule for db/database.js (organize.ts
 * calls the real getDb() singleton, which we replace with a fake that returns
 * an inert object — safe because FolderRepo/SettingsRepo only store the `db`
 * reference in their constructors and this test never invokes their query
 * methods, since --all bypasses folder auto-registration entirely) and for
 * organize-engine.js (so no real filesystem walk / EXIF parsing happens) and
 * ui.js (so ui.warn/info/error calls are observable without terminal output).
 * process.exit is intercepted to throw, matching test/commands/jobs.spec.ts.
 */

import { jest } from '@jest/globals';

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
// Mock organize/organize-engine.js — no real filesystem walk / EXIF parsing.
// ---------------------------------------------------------------------------
const mockEngineOn = jest.fn();
const mockEngineRun = jest.fn<() => Promise<{ totals: unknown }>>();
const MockOrganizeEngine = jest.fn().mockImplementation(() => ({
  on: mockEngineOn,
  run: mockEngineRun,
}));

jest.unstable_mockModule('../../src/organize/organize-engine.js', () => ({
  OrganizeEngine: MockOrganizeEngine,
}));

// Dynamic import AFTER all unstable_mockModule calls
const { organizeCommand } = await import('../../src/commands/organize.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleTotals(): {
  total: number;
  moved: number;
  skipped: number;
  conflicts: number;
  errors: number;
  nodate: number;
  byBucket: Record<string, number>;
} {
  return {
    total: 3,
    moved: 3,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    nodate: 1,
    byBucket: { NODATE: 1, '2023/07 - July': 2 },
  };
}

async function invokeOrganize(args: string[]): Promise<void> {
  const cmd = organizeCommand();
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('organize command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  describe('no folder args and no --all', () => {
    it('warns, informs, and exits 1 without constructing the engine', async () => {
      await expect(invokeOrganize([])).rejects.toThrow('process.exit(1)');

      expect(mockUiWarn).toHaveBeenCalledWith(expect.stringContaining('No folders specified'));
      expect(mockUiInfo).toHaveBeenCalled();
      expect(MockOrganizeEngine).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('--all --dry-run --json', () => {
    it('prints the totals as JSON to stdout and does not call process.exit', async () => {
      const totals = sampleTotals();
      mockEngineRun.mockResolvedValue({ totals });

      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await invokeOrganize(['--all', '--dry-run', '--json']);

      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(printed) as ReturnType<typeof sampleTotals>;
      expect(parsed).toEqual(totals);

      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({ all: true, dryRun: true }),
      );
      // JSON mode must not create a spinner (keeps stdout clean for scripting).
      expect(mockCreateSpinner).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });
  });

  describe('engine rejection', () => {
    it('reports the error via ui.error and exits 1', async () => {
      mockEngineRun.mockRejectedValue(new Error('No target folders specified. Pass folder paths, folder IDs, or --all.'));

      await expect(invokeOrganize(['--all', '--json'])).rejects.toThrow('process.exit(1)');

      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('No target folders specified'),
      );
    });
  });
});

// Suppress unused import warning
void jest;
