/**
 * test/tui/node-dashboard-daemon-start.spec.tsx
 *
 * Tests for the daemon-first start flow inside tui/NodeDashboard.tsx
 * (issue #156): in embedded mode, `s` spawns the DETACHED memory-tuned daemon
 * (node/daemon-launch.ts) and attaches to it instead of hosting an untuned
 * in-process engine — the interactive TUI process cannot re-exec to raise its
 * own ~2 GB default heap ceiling (PR #159), which is the exact posture that
 * OOM'd under sustained import load. `e` remains the explicit in-process
 * fallback, which must warn and tighten the memory watchdog when the process
 * heap is untuned.
 *
 * Mocking style mirrors test/tui/node-dashboard-doctor-overlay.spec.tsx
 * (capabilities/self-test/doctor-checks/models/ipc-client/api mocked so no
 * native lib, network, or real daemon is touched), plus:
 *   - node/daemon-launch.js — spawn/wait mocked, no real child process;
 *   - node/runtime-tuning.js — describeHeapTuning is controllable so the
 *     untuned-vs-tuned branches don't depend on the Jest process's real heap;
 *   - ipc-client's connectToDaemon returns a fake DaemonClient serving a
 *     canned snapshot frame, so the REAL createAttachedSource() runs.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import type { CliConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const NODE_JOB_TYPES = ['face_detection', 'auto_tagging'] as const;

jest.unstable_mockModule('../../src/node/capabilities.js', () => ({
  NODE_JOB_TYPES,
  isNodeJobType: (t: string) => (NODE_JOB_TYPES as readonly string[]).includes(t),
  detectCapabilities: jest.fn(),
  missingRequirements: jest.fn(),
  evaluateStartupSelfTest: jest.fn(),
  ComputeDispatcher: class {
    compute = jest.fn();
  },
  mergeOperationalCapabilities: (presence: unknown) => presence,
}));

jest.unstable_mockModule('../../src/node/self-test.js', () => ({
  runOperationalSelfTests: jest.fn(),
}));

jest.unstable_mockModule('../../src/node/doctor-checks.js', () => ({
  runApiAccessChecks: jest.fn(),
  checkDaemonLiveness: jest.fn(),
}));

jest.unstable_mockModule('../../src/node/models.js', () => ({
  ensureModels: jest.fn(async () => ({ targetDir: '/tmp/models', downloaded: [], present: [], failed: [] })),
}));

const isDaemonRunningMock = jest.fn<() => Promise<boolean>>(async () => false);
const connectToDaemonMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../../src/node/ipc-client.js', () => ({
  isDaemonRunning: isDaemonRunningMock,
  connectToDaemon: connectToDaemonMock,
}));

interface FakeSpawnResult {
  pid: number;
  outPath: string;
  logPath: string;
}
const spawnNodeStartDaemonMock = jest.fn<(...args: unknown[]) => FakeSpawnResult>();
const waitForDaemonReadyMock = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../../src/node/daemon-launch.js', () => ({
  spawnNodeStartDaemon: spawnNodeStartDaemonMock,
  waitForDaemonReady: waitForDaemonReadyMock,
  checkNodeAlreadyRunning: jest.fn(async () => ({ running: false })),
}));

interface HeapTuning {
  tuned: boolean;
  heapLimitMb: number;
  targetMb: number;
}
const describeHeapTuningMock = jest.fn<() => HeapTuning>(() => ({
  tuned: false,
  heapLimitMb: 2048,
  targetMb: 8192,
}));
jest.unstable_mockModule('../../src/node/runtime-tuning.js', () => ({
  maybeReexecWithHeapLimit: jest.fn(() => false),
  resolveHeapLimitMb: jest.fn(() => 8192),
  heapAlreadyTuned: jest.fn(() => false),
  heapNodeFlags: jest.fn(() => []),
  tunedChildEnv: jest.fn((env: unknown) => env),
  configureSharpRuntime: jest.fn(async () => {}),
  resolveSharpConcurrency: jest.fn(() => 1),
  resolveDefaultConcurrency: jest.fn(() => 2),
  currentHeapLimitMb: jest.fn(() => 2048),
  describeHeapTuning: describeHeapTuningMock,
}));

jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: class {
    constructor(_opts: unknown) {}
    async getModelManifest() {
      return [] as Array<{ name: string }>;
    }
    async claimNodeJobs() {
      return { jobs: [] };
    }
    async heartbeatNode() {
      return {};
    }
    async deregisterNode() {
      return {};
    }
    async renewLease() {
      return {};
    }
    async submitJobResult() {
      return {};
    }
    async reportJobFailure() {
      return {};
    }
  },
}));

const { NodeDashboard } = await import('../../src/tui/NodeDashboard.js');

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal fake DaemonClient (ipc-client shape) that lets the REAL
 * createAttachedSource() resolve: waitFor() finds the canned snapshot /
 * log-tail frames, onMessage/onClose callbacks are accepted and unused.
 */
function fakeDaemonClient(): unknown {
  const frames: Array<Record<string, unknown>> = [
    {
      kind: 'snapshot',
      nodeId: 'node-123',
      startedAt: new Date().toISOString(),
      concurrency: 3,
      eligibleTypes: ['face_detection'],
      activeJobs: [],
      history: [],
      counters: { succeeded: 1, failed: 0, claimed: 2 },
      lastHeartbeatAt: new Date().toISOString(),
      draining: false,
    },
    { kind: 'log-tail', lines: [] },
  ];
  return {
    onMessage: (_cb: (m: unknown) => void) => {},
    onClose: (_cb: () => void) => {},
    waitFor: async (pred: (m: Record<string, unknown>) => boolean) => {
      const hit = frames.find(pred);
      if (!hit) throw new Error('no matching frame');
      return hit;
    },
    send: (_msg: unknown) => {},
    close: () => {},
  };
}

const config: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
  nodeId: 'node-123',
  node: {
    name: 'test-node',
    concurrency: 1,
    eligibleTypes: ['face_detection'],
    pollIntervalMs: 5000,
  },
};

beforeEach(() => {
  isDaemonRunningMock.mockReset();
  isDaemonRunningMock.mockResolvedValue(false);
  connectToDaemonMock.mockReset();
  spawnNodeStartDaemonMock.mockReset();
  waitForDaemonReadyMock.mockReset();
  describeHeapTuningMock.mockReset();
  describeHeapTuningMock.mockReturnValue({ tuned: false, heapLimitMb: 2048, targetMb: 8192 });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// s — daemon-first start
// ---------------------------------------------------------------------------

describe('NodeDashboard [s] — spawn a tuned daemon and attach', () => {
  it('spawns the daemon, waits for its socket, and attaches', async () => {
    spawnNodeStartDaemonMock.mockReturnValue({ pid: 555, outPath: '/tmp/out.log', logPath: '/tmp/node.log' });
    waitForDaemonReadyMock.mockImplementation(async () => {
      // Once the daemon is "up", the re-detect in initSource() must find it.
      isDaemonRunningMock.mockResolvedValue(true);
      connectToDaemonMock.mockResolvedValue(fakeDaemonClient());
      return true;
    });

    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={config} onBack={() => {}} />,
    );
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain('EMBEDDED');

    stdin.write('s');
    await flushAsync(150);

    expect(spawnNodeStartDaemonMock).toHaveBeenCalledTimes(1);
    // No explicit options: the daemon resolves its own (core/RAM-aware) defaults.
    expect(spawnNodeStartDaemonMock).toHaveBeenCalledWith();
    expect(waitForDaemonReadyMock).toHaveBeenCalledTimes(1);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('ATTACHED');
    expect(plain).toContain('attached — the daemon keeps running');
    unmount();
  });

  it('logs an error (pointing at the out-log and [e]) when the daemon never comes up', async () => {
    spawnNodeStartDaemonMock.mockReturnValue({ pid: 777, outPath: '/tmp/out.log', logPath: '/tmp/node.log' });
    waitForDaemonReadyMock.mockResolvedValue(false);

    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={config} onBack={() => {}} />,
    );
    await flushAsync();

    stdin.write('s');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('EMBEDDED'); // still embedded, nothing attached
    expect(plain).toContain('daemon did not come up');
    unmount();
  });

  it('surfaces a synchronous spawn failure in the log', async () => {
    spawnNodeStartDaemonMock.mockImplementation(() => {
      throw new Error('EPERM: spawn not permitted');
    });

    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={config} onBack={() => {}} />,
    );
    await flushAsync();

    stdin.write('s');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('failed to launch the daemon');
    expect(waitForDaemonReadyMock).not.toHaveBeenCalled();
    unmount();
  });

  it('refuses to spawn when the machine is not registered', async () => {
    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={{ serverUrl: config.serverUrl, pat: config.pat }} onBack={() => {}} />,
    );
    await flushAsync();

    stdin.write('s');
    await flushAsync();

    expect(spawnNodeStartDaemonMock).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame()!)).toContain('Not registered');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// e — explicit in-process fallback with untuned-heap defense
// ---------------------------------------------------------------------------

describe('NodeDashboard [e] — in-process fallback', () => {
  it('starts the engine in-process without spawning a daemon, and warns when the heap is untuned', async () => {
    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={config} onBack={() => {}} />,
    );
    await flushAsync();

    stdin.write('e');
    await flushAsync(150);

    expect(spawnNodeStartDaemonMock).not.toHaveBeenCalled();
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('EMBEDDED');
    expect(plain).toContain('UNTUNED');
    unmount();
  });

  it('does not warn when the process heap already matches the tuned target', async () => {
    describeHeapTuningMock.mockReturnValue({ tuned: true, heapLimitMb: 8192, targetMb: 8192 });

    const { lastFrame, stdin, unmount } = render(
      <NodeDashboard config={config} onBack={() => {}} />,
    );
    await flushAsync();

    stdin.write('e');
    await flushAsync(150);

    expect(stripAnsi(lastFrame()!)).not.toContain('UNTUNED');
    unmount();
  });
});
