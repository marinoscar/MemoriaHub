/**
 * Smoke tests for src/ui.ts helpers.
 *
 * Run under NO_COLOR=1 (set below) so picocolors strips all ANSI sequences.
 * The tests assert that each helper writes a non-empty string and does not throw —
 * they do NOT assert on exact formatting or ANSI codes (presentation is allowed to
 * change without breaking tests).
 */

// Set NO_COLOR before ui.ts is imported so picocolors disables color output.
// This also exercises the non-TTY/no-color code paths.
process.env['NO_COLOR'] = '1';

import { ui } from '../src/ui';

describe('ui helpers — smoke under NO_COLOR', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let stdoutWrite: jest.SpyInstance;
  let stderrWrite: jest.SpyInstance;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    stderrWrite = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it('ui.success writes a non-empty line to stdout', () => {
    expect(() => ui.success('operation completed')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('operation completed');
  });

  it('ui.error writes a non-empty line to stderr', () => {
    expect(() => ui.error('something went wrong')).not.toThrow();
    expect(stderrChunks.join('')).toContain('something went wrong');
  });

  it('ui.warn writes a non-empty line to stdout', () => {
    expect(() => ui.warn('low disk space')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('low disk space');
  });

  it('ui.info writes a non-empty line to stdout', () => {
    expect(() => ui.info('found 5 files')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('found 5 files');
  });

  it('ui.dim writes a non-empty line to stdout', () => {
    expect(() => ui.dim('secondary detail')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('secondary detail');
  });

  it('ui.step writes a non-empty line to stdout', () => {
    expect(() => ui.step('scanning folder')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('scanning folder');
  });

  it('ui.line writes the exact text to stdout', () => {
    expect(() => ui.line('plain text')).not.toThrow();
    expect(stdoutChunks.join('')).toContain('plain text');
  });

  it('ui.blank writes a newline to stdout', () => {
    expect(() => ui.blank()).not.toThrow();
    expect(stdoutChunks.join('')).toContain('\n');
  });
});
