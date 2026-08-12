/**
 * test/tui/node-stop.spec.tsx
 *
 * Coverage for the Stop worker screen added by issue #413.
 *
 * The interesting logic is `runStopSequence` — the IPC → SIGTERM →
 * server-side-deregister escalation mirroring `stopCmd()` in commands/node.ts —
 * which is exported as a plain async function precisely so it can be tested
 * without Ink or a live daemon. Each tier is driven by mocking the module it
 * depends on, so the ORDER of escalation (and the fact that a failed tier falls
 * through to the next while still reporting what happened) is what is asserted,
 * not the internals of any one tier.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

const FAKE_CONFIG = { serverUrl: 'http://test.local', pat: 'tok-test', nodeId: 'node-1' };

// ---------------------------------------------------------------------------
// Module mocks — declared before the dynamic import of the unit under test.
// ---------------------------------------------------------------------------

const isDaemonRunning = jest.fn<() => Promise<boolean>>();
const connectToDaemon = jest.fn<() => Promise<unknown>>();
const readPidFile = jest.fn<() => { pid: number } | null>();
const isPidAlive = jest.fn<() => boolean>();
const deregisterNode = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../../src/node/ipc-client.js', () => ({
  isDaemonRunning,
  connectToDaemon,
}));
jest.unstable_mockModule('../../src/node/daemon.js', () => ({
  readPidFile,
  isPidAlive,
}));
jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: class {
    deregisterNode = deregisterNode;
  },
}));

const { NodeStop, runStopSequence } = await import('../../src/tui/NodeStop.js');

/** A daemon client whose stop ack resolves immediately and then closes. */
function fakeClient(): Record<string, unknown> {
  return {
    send: jest.fn(),
    onMessage: jest.fn(),
    onClose: (cb: () => void) => setTimeout(cb, 0),
    waitFor: jest.fn(async () => ({ kind: 'ack', cmd: 'stop' })),
    close: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  isDaemonRunning.mockResolvedValue(false);
  readPidFile.mockReturnValue(null);
  isPidAlive.mockReturnValue(false);
  deregisterNode.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe('runStopSequence', () => {
  it('prefers the graceful IPC stop when a daemon socket is live', async () => {
    isDaemonRunning.mockResolvedValue(true);
    connectToDaemon.mockResolvedValue(fakeClient());

    const res = await runStopSequence(FAKE_CONFIG);

    expect(res.ok).toBe(true);
    expect(res.lines.map((l) => l.text).join('\n')).toContain('stopped via IPC');
    // Never escalates past the tier that worked.
    expect(readPidFile).not.toHaveBeenCalled();
    expect(deregisterNode).not.toHaveBeenCalled();
  });

  it('falls back to SIGTERM when the IPC stop fails, and says why', async () => {
    isDaemonRunning.mockResolvedValue(true);
    connectToDaemon.mockRejectedValue(new Error('socket refused'));
    readPidFile.mockReturnValue({ pid: 4242 });
    isPidAlive.mockReturnValue(true);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      const res = await runStopSequence(FAKE_CONFIG);

      expect(res.ok).toBe(true);
      const text = res.lines.map((l) => l.text).join('\n');
      // The failed first tier stays visible rather than being collapsed away.
      expect(text).toContain('socket refused');
      expect(text).toContain('Sent SIGTERM to worker node (pid 4242)');
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
      expect(deregisterNode).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('deregisters server-side when there is no local process at all', async () => {
    const res = await runStopSequence(FAKE_CONFIG);

    expect(res.ok).toBe(true);
    expect(deregisterNode).toHaveBeenCalledWith('node-1');
    expect(res.lines.map((l) => l.text).join('\n')).toContain('deregistered server-side');
  });

  it('reports "nothing to stop" rather than erroring when logged out with no daemon', async () => {
    const res = await runStopSequence(null);

    expect(res.ok).toBe(false);
    expect(res.lines.map((l) => l.text).join('\n')).toContain('nothing to stop');
    expect(deregisterNode).not.toHaveBeenCalled();
  });

  it('reports an unregistered machine rather than calling the API', async () => {
    const res = await runStopSequence({ serverUrl: 'http://test.local', pat: 'tok' });

    expect(res.ok).toBe(false);
    expect(res.lines.map((l) => l.text).join('\n')).toContain('not registered');
    expect(deregisterNode).not.toHaveBeenCalled();
  });

  it('surfaces a failed server-side deregister instead of claiming success', async () => {
    deregisterNode.mockRejectedValue(new Error('403 forbidden'));

    const res = await runStopSequence(FAKE_CONFIG);

    expect(res.ok).toBe(false);
    expect(res.lines.map((l) => l.text).join('\n')).toContain('403 forbidden');
  });
});

describe('NodeStop screen', () => {
  it('asks for confirmation before stopping anything', () => {
    const { lastFrame } = render(<NodeStop config={FAKE_CONFIG} onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);

    expect(plain).toContain('Worker Node — Stop');
    expect(plain).toContain('[Enter/s] stop worker');
    expect(isDaemonRunning).not.toHaveBeenCalled();
  });

  it('Esc backs out without touching the daemon', async () => {
    const onBack = jest.fn();
    const { stdin } = render(<NodeStop config={FAKE_CONFIG} onBack={onBack} />);

    stdin.write('\x1B');
    await new Promise((r) => setTimeout(r, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(isDaemonRunning).not.toHaveBeenCalled();
  });

  it('runs the sequence on confirm and renders its outcome', async () => {
    isDaemonRunning.mockResolvedValue(true);
    connectToDaemon.mockResolvedValue(fakeClient());
    const onStopped = jest.fn();

    const { lastFrame, stdin } = render(
      <NodeStop config={FAKE_CONFIG} onStopped={onStopped} onBack={() => {}} />,
    );
    stdin.write('\r');

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !stripAnsi(lastFrame() ?? '').includes('stopped via IPC')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(stripAnsi(lastFrame()!)).toContain('stopped via IPC');
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});
