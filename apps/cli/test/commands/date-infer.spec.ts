/**
 * test/commands/date-infer.spec.ts — Unit tests for the `date-infer` command.
 *
 * Mirrors test/commands/organize.spec.ts's mocking strategy (db/database.js,
 * ui.js, process.exit interception) plus mocks for the extra collaborators
 * date-infer.ts pulls in that organize.ts does not: exif-writer.js
 * (detectExiftool/exiftoolInstallHint/endExiftool — the `apply`-mode
 * ExifTool-availability gate) and export/date-inference-export.js (report
 * writing, not exercised for real here). `paths.js`'s exportsDir() is left
 * un-mocked and pointed at a real temp directory so the command's
 * `fs.mkdirSync(dir, {recursive:true})` call operates on a real (harmless,
 * cleaned-up) path rather than requiring a further mock.
 *
 * Tests:
 *   - No folder args and no --all → warns + exits 1, engine never constructed
 *   - `apply` with ExifTool unavailable → error + install hint + exits 1,
 *     engine never constructed
 *   - `diagnose --all --json` → JSON summary (totals + reportPath) printed to
 *     stdout, no exit call, endExiftool NOT called (diagnose mode)
 *   - `apply --all --json` with ExifTool available → endExiftool IS called
 *   - Engine rejection → ui.error + exit(1)
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
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
// Mock date-inference/date-inference-engine.js — no real filesystem walk.
// ---------------------------------------------------------------------------
const mockEngineOn = jest.fn();
const mockEngineRun = jest.fn<() => Promise<{ totals: unknown }>>();
const MockDateInferenceEngine = jest.fn().mockImplementation(() => ({
  on: mockEngineOn,
  run: mockEngineRun,
}));

jest.unstable_mockModule('../../src/date-inference/date-inference-engine.js', () => ({
  DateInferenceEngine: MockDateInferenceEngine,
}));

// ---------------------------------------------------------------------------
// Mock date-inference/exif-writer.js
// ---------------------------------------------------------------------------
const mockDetectExiftool = jest.fn<() => Promise<{ available: boolean; version?: string }>>();
const mockExiftoolInstallHint = jest.fn(() => 'install ExifTool via ...');
const mockEndExiftool = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/date-inference/exif-writer.js', () => ({
  detectExiftool: mockDetectExiftool,
  exiftoolInstallHint: mockExiftoolInstallHint,
  endExiftool: mockEndExiftool,
}));

// ---------------------------------------------------------------------------
// Mock export/date-inference-export.js — no real xlsx/csv file is written.
// ---------------------------------------------------------------------------
const mockExportDateInference = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/export/date-inference-export.js', () => ({
  exportDateInference: mockExportDateInference,
}));

// ---------------------------------------------------------------------------
// Mock paths.js — point exportsDir() at a real (harmless) temp directory.
// ---------------------------------------------------------------------------
const exportsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-date-infer-cmd-exports-'));
jest.unstable_mockModule('../../src/paths.js', () => ({
  exportsDir: jest.fn(() => exportsTmpDir),
}));

// Dynamic import AFTER all unstable_mockModule calls
const { dateInferCommand } = await import('../../src/commands/date-infer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleTotals(): {
  total: number;
  hasDate: number;
  inferred: number;
  noPattern: number;
  written: number;
  writeFailed: number;
  errors: number;
  byPattern: Record<string, number>;
} {
  return {
    total: 3,
    hasDate: 1,
    inferred: 2,
    noPattern: 0,
    written: 0,
    writeFailed: 0,
    errors: 0,
    byPattern: { timestamp: 1, whatsapp: 1, delimited: 0, bare: 0 },
  };
}

async function invokeDateInfer(args: string[]): Promise<void> {
  const cmd = dateInferCommand();
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('date-infer command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectExiftool.mockResolvedValue({ available: true, version: '12.76' });
    mockEndExiftool.mockResolvedValue(undefined);
    mockExportDateInference.mockResolvedValue(undefined);
  });

  afterAll(() => {
    mockExit.mockRestore();
    fs.rmSync(exportsTmpDir, { recursive: true, force: true });
  });

  describe('no folder args and no --all', () => {
    it('warns, informs, and exits 1 without constructing the engine (diagnose)', async () => {
      await expect(invokeDateInfer(['diagnose'])).rejects.toThrow('process.exit(1)');

      expect(mockUiWarn).toHaveBeenCalledWith(expect.stringContaining('No folders specified'));
      expect(mockUiInfo).toHaveBeenCalled();
      expect(MockDateInferenceEngine).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('apply mode with ExifTool unavailable', () => {
    it('errors with the install hint and exits 1 without constructing the engine', async () => {
      mockDetectExiftool.mockResolvedValue({ available: false });

      await expect(invokeDateInfer(['apply', '--all'])).rejects.toThrow('process.exit(1)');

      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('ExifTool is not available'),
      );
      expect(mockExiftoolInstallHint).toHaveBeenCalled();
      expect(MockDateInferenceEngine).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('diagnose --all --json', () => {
    it('prints the totals (plus reportPath) as JSON to stdout, does not call process.exit, and never touches ExifTool', async () => {
      const totals = sampleTotals();
      mockEngineRun.mockResolvedValue({ totals });

      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await invokeDateInfer(['diagnose', '--all', '--json']);

      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(printed) as ReturnType<typeof sampleTotals> & { reportPath: string };
      expect(parsed).toMatchObject(totals);
      expect(parsed.reportPath).toEqual(expect.stringContaining(exportsTmpDir));

      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({ all: true, mode: 'diagnose' }),
      );
      expect(mockDetectExiftool).not.toHaveBeenCalled();
      expect(mockEndExiftool).not.toHaveBeenCalled();
      expect(mockCreateSpinner).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });
  });

  describe('apply --all --json with ExifTool available', () => {
    it('runs the engine in apply mode and calls endExiftool exactly once in the finally block', async () => {
      const totals = { ...sampleTotals(), written: 2, inferred: 0 };
      mockEngineRun.mockResolvedValue({ totals });

      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await invokeDateInfer(['apply', '--all', '--json']);

      expect(mockDetectExiftool).toHaveBeenCalledTimes(1);
      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({ all: true, mode: 'apply' }),
      );
      expect(mockEndExiftool).toHaveBeenCalledTimes(1);
      expect(mockExit).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });
  });

  describe('engine rejection', () => {
    it('reports the error via ui.error and exits 1', async () => {
      mockEngineRun.mockRejectedValue(
        new Error('No target folders specified. Pass folder paths, folder IDs, or --all.'),
      );

      await expect(invokeDateInfer(['diagnose', '--all', '--json'])).rejects.toThrow(
        'process.exit(1)',
      );

      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('No target folders specified'),
      );
    });
  });
});

// Suppress unused import warning
void jest;
