/**
 * test/tui/node-start.spec.tsx
 *
 * Tests for NodeStart.tsx — the TUI screen that launches a real background
 * worker-node daemon via node/daemon-launch.ts. That module is mocked
 * entirely (jest.unstable_mockModule) so no real child process is spawned
 * and no real pidfile/IPC socket is touched — mirrors the mocking style of
 * test/tui/node-service.spec.tsx (spawnSync mocked) and
 * test/node/daemon-launch.spec.ts (the module's own unit tests).
 *
 * Mock modules must be registered with jest.unstable_mockModule BEFORE the
 * module under test is imported, so both are dynamically imported via
 * `await import(...)` at module scope (ESM + ts-jest convention used
 * elsewhere in this test suite).
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import type { CliConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

interface FakeAlreadyRunning {
  running: boolean;
  pid?: number;
  via?: 'pidfile' | 'ipc';
}

interface FakeSpawnResult {
  pid: number;
  outPath: string;
  logPath: string;
}

const spawnNodeStartDaemonMock = jest.fn<(...args: unknown[]) => FakeSpawnResult>();
const checkNodeAlreadyRunningMock = jest.fn<() => Promise<FakeAlreadyRunning>>();
const waitForDaemonReadyMock = jest.fn<(...args: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('../../src/node/daemon-launch.js', () => ({
  spawnNodeStartDaemon: spawnNodeStartDaemonMock,
  checkNodeAlreadyRunning: checkNodeAlreadyRunningMock,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

const { NodeStart } = await import('../../src/tui/NodeStart.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeSpawnResult(overrides: Partial<FakeSpawnResult> = {}): FakeSpawnResult {
  return { pid: 4242, outPath: '/tmp/node.out.log', logPath: '/tmp/node.log', ...overrides };
}

const registeredConfig: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
  nodeId: 'node-123',
  node: {
    name: 'test-node',
    concurrency: 2,
    eligibleTypes: ['auto_tagging', 'geocode'],
    pollIntervalMs: 5000,
  },
};

const unregisteredConfig: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
};

beforeEach(() => {
  spawnNodeStartDaemonMock.mockReset();
  checkNodeAlreadyRunningMock.mockReset();
  waitForDaemonReadyMock.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Not-registered short-circuit
// ---------------------------------------------------------------------------

describe('NodeStart — not registered', () => {
  it('renders the not-registered message without ever probing for a running daemon', async () => {
    const { lastFrame, unmount } = render(
      <NodeStart config={unregisteredConfig} onStarted={() => {}} onBack={() => {}} />,
    );
    await flushAsync();
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('not registered');
    expect(checkNodeAlreadyRunningMock).not.toHaveBeenCalled();
    unmount();
  });

  it('calls onBack on Enter', async () => {
    const onBack = jest.fn();
    const { stdin, unmount } = render(
      <NodeStart config={unregisteredConfig} onStarted={() => {}} onBack={onBack} />,
    );
    stdin.write('\r');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('calls onBack on "b"', async () => {
    const onBack = jest.fn();
    const { stdin, unmount } = render(
      <NodeStart config={unregisteredConfig} onStarted={() => {}} onBack={onBack} />,
    );
    stdin.write('b');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Already-running
// ---------------------------------------------------------------------------

describe('NodeStart — already running', () => {
  it('renders the already-running state with pid and source', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: true, via: 'pidfile', pid: 123 });

    const { lastFrame, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={() => {}} />,
    );
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('already running');
    expect(plain).toContain('123');
    expect(plain).toContain('pidfile');
    unmount();
  });

  it('calls onStarted on Enter', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: true, via: 'ipc', pid: 999 });
    const onStarted = jest.fn();

    const { stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={onStarted} onBack={() => {}} />,
    );
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    expect(onStarted).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('calls onBack on "b" instead of starting a second daemon', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: true, via: 'ipc' });
    const onBack = jest.fn();

    const { stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={onBack} />,
    );
    await flushAsync();
    stdin.write('b');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(spawnNodeStartDaemonMock).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Happy path: form -> starting -> success
// ---------------------------------------------------------------------------

describe('NodeStart — happy path', () => {
  it('renders the form prefilled from config.node once no daemon is already running', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });

    const { lastFrame, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={() => {}} />,
    );
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Concurrency');
    expect(plain).toContain('2'); // prefilled from config.node.concurrency
    expect(plain).toContain('auto_tagging');
    expect(plain).toContain('geocode');
    unmount();
  });

  it('spawns the daemon and reaches success once waitForDaemonReady resolves true', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });
    spawnNodeStartDaemonMock.mockReturnValue(fakeSpawnResult({ pid: 555 }));
    waitForDaemonReadyMock.mockResolvedValue(true);
    const onStarted = jest.fn();

    const { lastFrame, stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={onStarted} onBack={() => {}} />,
    );
    await flushAsync();

    // Enter on the concurrency field advances focus to the types list.
    stdin.write('\r');
    await flushAsync();
    // Enter on the types list (default selection carried over from config) submits.
    stdin.write('\r');
    await flushAsync();

    expect(spawnNodeStartDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 2 }),
    );
    expect(waitForDaemonReadyMock).toHaveBeenCalledTimes(1);

    let plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('started');
    expect(plain).toContain('555');

    stdin.write('\r');
    await flushAsync();
    expect(onStarted).toHaveBeenCalledTimes(1);

    plain = stripAnsi(lastFrame()!);
    unmount();
  });

  it('catches a synchronous spawn failure and shows the error step', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });
    spawnNodeStartDaemonMock.mockImplementation(() => {
      throw new Error('EPERM: spawn not permitted');
    });
    const onBack = jest.fn();

    const { lastFrame, stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={onBack} />,
    );
    await flushAsync();
    stdin.write('\r');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('EPERM');

    stdin.write('b');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Timeout path
// ---------------------------------------------------------------------------

describe('NodeStart — timeout', () => {
  it('shows the timeout warning with pid/log paths, and onStarted still fires on "open anyway"', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });
    spawnNodeStartDaemonMock.mockReturnValue(
      fakeSpawnResult({ pid: 777, outPath: '/tmp/out.log', logPath: '/tmp/node-777.log' }),
    );
    waitForDaemonReadyMock.mockResolvedValue(false);
    const onStarted = jest.fn();

    const { lastFrame, stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={onStarted} onBack={() => {}} />,
    );
    await flushAsync();
    stdin.write('\r');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('777');
    expect(plain).toContain('/tmp/out.log');
    expect(plain).toContain('/tmp/node-777.log');

    stdin.write('\r');
    await flushAsync();
    expect(onStarted).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('goes back without calling onStarted on "b"', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });
    spawnNodeStartDaemonMock.mockReturnValue(fakeSpawnResult());
    waitForDaemonReadyMock.mockResolvedValue(false);
    const onStarted = jest.fn();
    const onBack = jest.fn();

    const { stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={onStarted} onBack={onBack} />,
    );
    await flushAsync();
    stdin.write('\r');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    stdin.write('b');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Concurrency / types field editing
// ---------------------------------------------------------------------------

describe('NodeStart — form field editing', () => {
  it('adjusts concurrency up/down with arrow keys (NodeLogs.tsx-style stepper)', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });

    const { lastFrame, stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={() => {}} />,
    );
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain('Concurrency    2');

    stdin.write('\x1B[A'); // up arrow
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain('Concurrency    3');

    stdin.write('\x1B[B'); // down arrow
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain('Concurrency    1');
    unmount();
  });

  it('toggles a job type with space after moving focus to the types list', async () => {
    checkNodeAlreadyRunningMock.mockResolvedValue({ running: false });
    spawnNodeStartDaemonMock.mockReturnValue(fakeSpawnResult());
    waitForDaemonReadyMock.mockResolvedValue(true);

    const { stdin, unmount } = render(
      <NodeStart config={registeredConfig} onStarted={() => {}} onBack={() => {}} />,
    );
    await flushAsync();

    // Move focus to the types list, then toggle the cursor item (the first
    // NODE_JOB_TYPES entry, not part of registeredConfig's selection) on and
    // back off — net no-op on the selection, but exercises the space-toggle
    // interaction before submitting with the original config-derived set.
    stdin.write('\t');
    await flushAsync();
    stdin.write(' ');
    await flushAsync();
    stdin.write(' ');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    expect(spawnNodeStartDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 2, types: ['auto_tagging', 'geocode'] }),
    );
    unmount();
  });
});
