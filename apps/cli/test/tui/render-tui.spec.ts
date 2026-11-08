/**
 * test/tui/render-tui.spec.ts  (was raw-mode.spec.ts; RETRO-F4, #582)
 *
 * Unit tests for tui/render-tui.ts, the safe Ink launch the two standalone
 * dashboards (`jobs`, `scan`) use. The raw-mode probe and the `/dev/tty`
 * fallback it relies on moved to the platform (`canUseRawMode`,
 * `resolveInteractiveStdin` in `@marinoscar/platform-cli/tui`), so the 1.3
 * `canUseRawMode` cases now run against the platform export and every
 * `renderTui` case runs unchanged against the new module: this still fixes the
 * `setRawMode EIO` crash on terminals that can't support raw mode
 * (serial/LXC/hypervisor consoles, redirected stdin).
 *
 * `resolveInteractiveStdin` is exercised through `renderTui`, with
 * `process.stdin`/`process.stdout.isTTY` stubbed and `node:fs`'s `openSync`
 * mocked. Ink's `render` is mocked via jest.unstable_mockModule since this
 * module calls it directly as a side-effecting launcher rather than being a
 * component itself — there's no existing ink-testing-library precedent for
 * that shape in this repo.
 */

import { createRequire } from 'node:module';
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const mockRender = jest.fn();
jest.unstable_mockModule('ink', () => ({
  render: mockRender,
}));

// Only `openSync` is replaced: the platform's TUI module graph reads other `node:fs` exports
// (readFileSync, ...) when it loads, so the rest of the real module stays.
const mockOpenSync = jest.fn();
const realFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  default: { ...realFs, openSync: mockOpenSync },
  openSync: mockOpenSync,
}));

const { canUseRawMode } = await import('@marinoscar/platform-cli/tui');
const { renderTui } = await import('../../src/tui/render-tui.js');

// ---------------------------------------------------------------------------
// canUseRawMode
// ---------------------------------------------------------------------------

describe('canUseRawMode', () => {
  it('returns false for null and undefined', () => {
    expect(canUseRawMode(null)).toBe(false);
    expect(canUseRawMode(undefined)).toBe(false);
  });

  it('returns false when isTTY is falsy', () => {
    const stream = { isTTY: false, setRawMode: jest.fn() };
    expect(canUseRawMode(stream)).toBe(false);
  });

  it('returns false when setRawMode is missing', () => {
    const stream = { isTTY: true };
    expect(canUseRawMode(stream)).toBe(false);
  });

  it('returns false when setRawMode is not a function', () => {
    const stream = { isTTY: true, setRawMode: 'nope' };
    expect(canUseRawMode(stream)).toBe(false);
  });

  it('returns false and does not throw when setRawMode throws (EIO case)', () => {
    const stream = {
      isTTY: true,
      setRawMode: () => {
        throw new Error('EIO');
      },
    };
    let result: boolean | undefined;
    expect(() => {
      result = canUseRawMode(stream);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns true and toggles raw mode on then off for a working stream', () => {
    const setRawMode = jest.fn();
    const stream = { isTTY: true, setRawMode };
    expect(canUseRawMode(stream)).toBe(true);
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });
});

// ---------------------------------------------------------------------------
// renderTui (and resolveInteractiveStdin, exercised indirectly)
// ---------------------------------------------------------------------------

describe('renderTui', () => {
  let stdoutWriteSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let originalStdoutIsTTY: PropertyDescriptor | undefined;
  let originalStdin: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockRender.mockReset();
    mockOpenSync.mockReset();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
    }
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  });

  const element = { type: 'fake-element' } as unknown as import('react').ReactElement;

  it('writes the needs-a-real-terminal message and does not render when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await renderTui(element);

    expect(mockRender).not.toHaveBeenCalled();
    const written = stdoutWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('needs a real terminal');
  });

  it('calls Ink render with the resolved stdin when stdout is a TTY and stdin supports raw mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const fakeStdin = { isTTY: true, setRawMode: jest.fn() };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    mockRender.mockReturnValue({ waitUntilExit: () => Promise.resolve() });

    await renderTui(element);

    expect(mockRender).toHaveBeenCalledTimes(1);
    const [renderedElement, options] = mockRender.mock.calls[0] as [unknown, { stdin: unknown }];
    expect(renderedElement).toBe(element);
    expect(options.stdin).toBe(fakeStdin);
  });

  it("writes the can't-run-interactive-UI message and does not render when stdin can't do raw mode and /dev/tty is unavailable", async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const fakeStdin = { isTTY: false, setRawMode: jest.fn() };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    mockOpenSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, open \'/dev/tty\'');
    });

    await renderTui(element);

    expect(mockRender).not.toHaveBeenCalled();
    const written = stdoutWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain("can't run the interactive UI");
  });

  it('resolves (does not reject) and writes a degraded message when Ink render throws synchronously', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const fakeStdin = { isTTY: true, setRawMode: jest.fn() };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    mockRender.mockImplementation(() => {
      throw new Error('EIO');
    });

    await expect(renderTui(element)).resolves.toBeUndefined();

    const written = stdoutWriteSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('could not start');
    expect(written).toContain('EIO');
  });
});
