/**
 * test/node/daemon-launch.spec.ts
 *
 * Unit tests for node/daemon-launch.ts — the argv-independent daemon
 * launcher used by both a future TUI "start as daemon" screen and (after
 * refactor) commands/node.ts's startCmd() up-front already-running guard.
 *
 * Strategy:
 *   - `spawnNodeStartDaemon`: mock 'node:child_process' (jest.unstable_mockModule)
 *     so no real process is spawned; assert on the constructed argv and that
 *     `child.unref()` is called. Also mock 'os' (same pattern as
 *     test/reset.spec.ts / test/node/doctor-checks.spec.ts) so paths.ts's
 *     logsDir()/nodeLogPath() resolve under a throwaway temp directory
 *     instead of the real ~/.memoriahub.
 *   - `checkNodeAlreadyRunning`: mock './daemon.js' (readPidFile/isPidAlive)
 *     and './ipc-client.js' (isDaemonRunning) directly — no real pidfile or
 *     socket involved.
 *   - `waitForDaemonReady`: mock './ipc-client.js' only; use short
 *     timeout/interval values so the "never becomes ready" case doesn't
 *     actually wait the real default 8s.
 *
 * Mock modules must be registered with jest.unstable_mockModule BEFORE the
 * module under test is imported, so everything is dynamically imported via
 * `await import(...)` at module scope (ESM + ts-jest convention used
 * elsewhere in this test suite).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

interface FakeChild {
  pid: number;
  unref: jest.Mock;
}

const spawnMock = jest.fn<(...args: unknown[]) => FakeChild>();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
}));

let fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => (fakeHome !== '' ? fakeHome : actualOs.homedir())),
}));

const readPidFileMock = jest.fn();
const isPidAliveMock = jest.fn();

jest.unstable_mockModule('../../src/node/daemon.js', () => ({
  readPidFile: readPidFileMock,
  isPidAlive: isPidAliveMock,
}));

const isDaemonRunningMock = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule('../../src/node/ipc-client.js', () => ({
  isDaemonRunning: isDaemonRunningMock,
}));

const { spawnNodeStartDaemon, checkNodeAlreadyRunning, waitForDaemonReady } = await import(
  '../../src/node/daemon-launch.js'
);
const { logsDir, nodePidPath, nodeSocketPath } = await import('../../src/paths.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeChild(pid = 4242): FakeChild {
  return { pid, unref: jest.fn() };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('spawnNodeStartDaemon', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-daemon-launch-'));
    fakeHome = tmpDir;
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  afterEach(() => {
    fakeHome = '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('builds argv [node, start] with no flags when no options are given', () => {
    const result = spawnNodeStartDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, argv, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(execPath).toBe(process.execPath);
    expect(argv).toEqual([process.argv[1], 'node', 'start']);
    expect(opts['detached']).toBe(true);
    expect(Array.isArray(opts['stdio'])).toBe(true);
    expect((opts['stdio'] as unknown[])[0]).toBe('ignore');

    expect(result.pid).toBe(4242);
    expect(result.outPath).toBe(path.join(logsDir(), 'node.out.log'));
  });

  it('appends --concurrency <n> when concurrency is given', () => {
    spawnNodeStartDaemon({ concurrency: 3 });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(argv).toEqual([process.argv[1], 'node', 'start', '--concurrency', '3']);
  });

  it('appends --types <csv> when types is given', () => {
    spawnNodeStartDaemon({ types: ['auto_tagging', 'geocode'] });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(argv).toEqual([process.argv[1], 'node', 'start', '--types', 'auto_tagging,geocode']);
  });

  it('appends --poll <ms> when poll is given', () => {
    spawnNodeStartDaemon({ poll: 10000 });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(argv).toEqual([process.argv[1], 'node', 'start', '--poll', '10000']);
  });

  it('appends all three flags in order when all options are given', () => {
    spawnNodeStartDaemon({ concurrency: 2, types: ['face_detection'], poll: 5000 });
    const [, argv] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(argv).toEqual([
      process.argv[1],
      'node',
      'start',
      '--concurrency',
      '2',
      '--types',
      'face_detection',
      '--poll',
      '5000',
    ]);
  });

  it('calls child.unref()', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    spawnNodeStartDaemon();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});

describe('checkNodeAlreadyRunning', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns {running:false} when neither the pidfile nor IPC show a live process', async () => {
    readPidFileMock.mockReturnValue(null);
    isDaemonRunningMock.mockResolvedValue(false);

    const result = await checkNodeAlreadyRunning();

    expect(result).toEqual({ running: false });
  });

  it("returns {running:true, via:'pidfile'} when a live pidfile exists", async () => {
    readPidFileMock.mockReturnValue({ pid: 777, startedAt: new Date().toISOString(), socketPath: nodeSocketPath() });
    isPidAliveMock.mockReturnValue(true);
    isDaemonRunningMock.mockResolvedValue(false);

    const result = await checkNodeAlreadyRunning();

    expect(result).toEqual({ running: true, pid: 777, via: 'pidfile' });
    // IPC is never consulted once the pidfile guard already found a live pid.
    expect(isDaemonRunningMock).not.toHaveBeenCalled();
  });

  it("returns {running:true, via:'ipc'} when only the IPC socket is live", async () => {
    readPidFileMock.mockReturnValue(null);
    isDaemonRunningMock.mockResolvedValue(true);

    const result = await checkNodeAlreadyRunning();

    expect(result).toEqual({ running: true, via: 'ipc' });
  });

  it('falls through to the IPC check when the pidfile exists but its pid is dead', async () => {
    readPidFileMock.mockReturnValue({ pid: 999, startedAt: new Date().toISOString(), socketPath: nodeSocketPath() });
    isPidAliveMock.mockReturnValue(false);
    isDaemonRunningMock.mockResolvedValue(true);

    const result = await checkNodeAlreadyRunning();

    expect(result).toEqual({ running: true, via: 'ipc' });
  });

  it('uses the real nodePidPath()/nodeSocketPath() helpers (sanity check paths.js import)', () => {
    expect(typeof nodePidPath()).toBe('string');
  });
});

describe('waitForDaemonReady', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resolves true quickly when isDaemonRunning already returns true', async () => {
    isDaemonRunningMock.mockResolvedValue(true);

    const start = Date.now();
    const ready = await waitForDaemonReady(200, 50);
    const elapsed = Date.now() - start;

    expect(ready).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it('resolves false after the timeout when isDaemonRunning never returns true', async () => {
    isDaemonRunningMock.mockResolvedValue(false);

    const ready = await waitForDaemonReady(200, 50);

    expect(ready).toBe(false);
    expect(isDaemonRunningMock.mock.calls.length).toBeGreaterThan(1);
  });
});
