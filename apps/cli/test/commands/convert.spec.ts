/**
 * test/commands/convert.spec.ts — Unit tests for the `convert` command.
 *
 * Mirrors test/commands/organize.spec.ts. db/database.js, ui.js, and
 * convert-engine.js are mocked; the real ffmpeg.js is used so
 * `FfmpegNotFoundError instanceof` checks match. process.exit is intercepted.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env['NO_COLOR'] = '1';

const mockExit = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
  throw new Error(`process.exit(${String(_code)})`);
});

const mockGetDb = jest.fn(() => ({}) as any);
jest.unstable_mockModule('../../src/db/database.js', () => ({
  getDb: mockGetDb,
  openDb: jest.fn(),
  closeDb: jest.fn(),
}));

const mockUiWarn = jest.fn();
const mockUiInfo = jest.fn();
const mockUiError = jest.fn();
const mockUiSuccess = jest.fn();
const mockSpinner = { start: jest.fn(), succeed: jest.fn(), fail: jest.fn(), text: '' };
const mockCreateSpinner = jest.fn(() => mockSpinner);

jest.unstable_mockModule('../../src/ui.js', () => ({
  ui: { warn: mockUiWarn, info: mockUiInfo, error: mockUiError, success: mockUiSuccess },
  createSpinner: mockCreateSpinner,
  isTTY: false,
  printBox: jest.fn(),
}));

const mockEngineOn = jest.fn();
const mockEngineRun = jest.fn<() => Promise<{ totals: unknown }>>();
const MockConvertEngine = jest.fn().mockImplementation(() => ({
  on: mockEngineOn,
  run: mockEngineRun,
}));

jest.unstable_mockModule('../../src/convert/convert-engine.js', () => ({
  ConvertEngine: MockConvertEngine,
}));

const { convertCommand } = await import('../../src/commands/convert.js');
const { FfmpegNotFoundError } = await import('../../src/convert/ffmpeg.js');

function sampleTotals(): Record<string, unknown> {
  return {
    total: 2, converted: 2, skipped: 0, errors: 0, deleted: 0,
    remuxed: 1, reencoded: 1, bytesIn: 200, bytesOut: 120,
  };
}

async function invokeConvert(args: string[]): Promise<void> {
  const cmd = convertCommand();
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

describe('convert command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  it('warns and exits 1 with no paths and no --all, without building the engine', async () => {
    await expect(invokeConvert([])).rejects.toThrow('process.exit(1)');
    expect(mockUiWarn).toHaveBeenCalledWith(expect.stringContaining('No files or folders'));
    expect(MockConvertEngine).not.toHaveBeenCalled();
  });

  it('--all --dry-run --json prints totals as JSON, no spinner, no exit', async () => {
    const totals = sampleTotals();
    mockEngineRun.mockResolvedValue({ totals });
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await invokeConvert(['--all', '--dry-run', '--json']);

    const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(printed)).toEqual(totals);
    expect(mockEngineRun).toHaveBeenCalledWith(expect.objectContaining({ all: true, dryRun: true }));
    expect(mockCreateSpinner).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
  });

  it('classifies a file argument into engine files[]', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-convert-cmd-'));
    const file = path.join(tmpDir, 'a.mov');
    fs.writeFileSync(file, 'x');
    mockEngineRun.mockResolvedValue({ totals: sampleTotals() });

    try {
      await invokeConvert([file, '--json']);
      expect(mockEngineRun).toHaveBeenCalledWith(
        expect.objectContaining({ files: [file] }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports ffmpeg-not-found with an install hint and exits 1', async () => {
    mockEngineRun.mockRejectedValue(new FfmpegNotFoundError());

    await expect(invokeConvert(['--all'])).rejects.toThrow('process.exit(1)');

    expect(mockUiError).toHaveBeenCalledWith(expect.stringContaining('ffmpeg'));
    expect(mockUiInfo).toHaveBeenCalledWith(expect.stringMatching(/install ffmpeg/i));
  });
});

void jest;
