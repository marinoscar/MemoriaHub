/**
 * test/tui/app-launch.spec.ts
 *
 * Regression guard for the `launchTui()` re-exec bug: `launchTui()` in
 * tui/app.tsx used to call `maybeReexecWithHeapLimit()` (from
 * ../node/runtime-tuning.js) before rendering the Ink UI. That re-exec spawns
 * a child node process with a different heap-limit flag, and the re-exec'd
 * child loses raw-mode control over the terminal (`setRawMode EIO`), breaking
 * the interactive TUI. The fix removed that call from `launchTui`; this test
 * fails if it is ever reintroduced.
 *
 * (`node start`'s use of `maybeReexecWithHeapLimit()` for the long-running
 * daemon in commands/node.ts is unrelated and correct — out of scope here.)
 *
 * Mirrors test/tui/raw-mode.spec.ts's conventions: this repo's Jest config
 * runs ESM (`NODE_OPTIONS=--experimental-vm-modules`), so mocking is done via
 * `jest.unstable_mockModule(...)` before any dynamic `await import(...)` of
 * the module under test, and `ink`'s `render` is mocked the same way (a
 * `jest.fn()` spy returning `{ waitUntilExit: () => Promise.resolve() }`).
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const mockRender = jest.fn();
jest.unstable_mockModule('ink', () => ({
  render: mockRender,
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: jest.fn() }),
  useInput: () => {},
}));

// app.tsx imports `maybeReexecWithHeapLimit` from this sibling module. Stub
// every export it might destructure so the mocked module import is complete
// (an undefined export used as a function would throw at call time, but more
// importantly we need to observe whether it's ever invoked).
const mockMaybeReexecWithHeapLimit = jest.fn(() => false);
jest.unstable_mockModule('../../src/node/runtime-tuning.js', () => ({
  maybeReexecWithHeapLimit: mockMaybeReexecWithHeapLimit,
  resolveHeapLimitMb: jest.fn(() => 0),
  heapAlreadyTuned: jest.fn(() => true),
  heapNodeFlags: jest.fn(() => []),
  tunedChildEnv: jest.fn((env: unknown) => env),
  configureSharpRuntime: jest.fn(async () => {}),
  resolveSharpConcurrency: jest.fn(() => 1),
  resolveDefaultConcurrency: jest.fn(() => 2),
}));

const { launchTui } = await import('../../src/tui/app.js');

// ---------------------------------------------------------------------------
// launchTui
// ---------------------------------------------------------------------------

describe('launchTui', () => {
  let originalStdoutIsTTY: PropertyDescriptor | undefined;
  let originalStdin: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockRender.mockClear();
    mockMaybeReexecWithHeapLimit.mockClear();
    mockRender.mockReturnValue({ waitUntilExit: () => Promise.resolve() });

    originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const fakeStdin = { isTTY: true, setRawMode: jest.fn() };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
  });

  afterEach(() => {
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
    }
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  });

  it('never calls maybeReexecWithHeapLimit and proceeds to render the Ink UI in-process', async () => {
    await launchTui({ currentVersion: '9.9.9' });

    // Core regression guard: the interactive TUI path must NEVER re-exec to
    // tune the V8 heap — that re-exec breaks raw-mode terminal control.
    expect(mockMaybeReexecWithHeapLimit).toHaveBeenCalledTimes(0);

    // Confirms the TUI actually proceeded to render in-process (not exited
    // early for some unrelated reason, e.g. a bad TTY stub).
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});
