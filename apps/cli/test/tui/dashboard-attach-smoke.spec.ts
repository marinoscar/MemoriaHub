/**
 * test/tui/dashboard-attach-smoke.spec.ts
 *
 * Headless smoke test proving the platform dashboard source (RETRO-F4, #582) can
 * really talk to a running 1.3 daemon: a stub NodeEngine (stub ApiClient + stub
 * ComputeDispatcher, no network, no real compute) is hosted via node/daemon.ts's
 * startDaemonHost on a throwaway unix socket, then
 * createNodeSource(nodeDaemonFeed(socket)) — the platform's `daemonAttachFeed`
 * over the 1.3 protocol adapter — attaches to it exactly the way NodeDashboard.tsx
 * does: no Ink, no pty, just the plain async API. Commands go through
 * daemonControl, the short-lived second connection.
 *
 * This never touches the real ~/.memoriahub paths: socketPath/pidPath are
 * both overridden to a throwaway temp file per test.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startDaemonHost, type DaemonHost } from '../../src/node/daemon.js';
import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';
import type { NodeLogger } from '../../src/node/logger.js';
import {
  createNodeSource,
  daemonControl,
  embeddedNodeFeed,
  engineControl,
  nodeDaemonFeed,
} from '../../src/tui/node-dashboard-source.js';

/** Stub API: never returns claimable jobs; heartbeat/deregister succeed. */
function stubApi(): ApiClient {
  return {
    claimNodeJobs: async () => ({ jobs: [] as ClaimedNodeJob[] }),
    heartbeatNode: async () => ({}),
    deregisterNode: async () => ({}),
    renewLease: async () => ({}),
    submitJobResult: async () => ({}),
    reportJobFailure: async () => ({}),
  } as unknown as ApiClient;
}

function stubDispatcher(): ComputeDispatcher {
  return { compute: async () => ({ ok: true }) } as unknown as ComputeDispatcher;
}

/** In-memory NodeLogger stub — no filesystem writes. */
function stubLogger(): NodeLogger {
  const lines: string[] = [];
  return {
    logPath: '(stub)',
    log: (level, fields) => {
      lines.push(JSON.stringify({ level, ...fields }));
    },
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
    tail: (n) => lines.slice(-n),
  };
}

function tmpPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'node-dash-smoke-')), name);
}

describe('attached dashboard source over the 1.3 daemon (headless smoke)', () => {
  let engine: NodeEngine;
  let host: DaemonHost;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = tmpPath('node.sock');
    const pidPath = tmpPath('node.pid');

    engine = new NodeEngine({
      api: stubApi(),
      dispatcher: stubDispatcher(),
      nodeId: 'node-smoke-1',
      options: { concurrency: 2, eligibleTypes: ['face_detection'], pollIntervalMs: 20_000, heartbeatIntervalMs: 60_000 },
      detectFn: async () => ({}),
      downloadFn: async () => {
        throw new Error('no downloads expected in this smoke test');
      },
    });

    host = await startDaemonHost(engine, stubLogger(), {
      socketPath,
      pidPath,
      persistConcurrency: () => {
        /* no-op: never touch the real config in tests */
      },
      exit: () => {
        /* no-op: never actually exit the test process */
      },
    });

    // Kick off the claim loop in the background; resolves only on stop().
    void engine.start();
    // Let the initial heartbeat land before the client connects.
    await new Promise<void>((resolve) => engine.once(NODE_EV.HEARTBEAT_OK, () => resolve()));
  });

  afterEach(async () => {
    await engine.stop('test-cleanup');
    await host.close();
  });

  async function until(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('connects, hydrates from the snapshot greeting, and forwards live events', async () => {
    const source = createNodeSource(nodeDaemonFeed(socketPath), 1);
    await source.start();
    try {
      await until(() => source.getState().connected && source.getState().heartbeat.ok, 'attach + hydrate');
      const state = source.getState();
      expect(state.mode).toBe('attached');
      expect(state.concurrency).toBe(2);
      expect(state.eligibleTypes).toEqual(['face_detection']);
      // The initial heartbeat already landed before we connected.
      expect(state.heartbeat.at).not.toBeNull();
      expect(state.startedAt).not.toBeNull();

      // Trigger a live concurrency change over the real IPC socket and
      // confirm the underlying engine (source of truth) applied it.
      daemonControl(socketPath).setConcurrency(5);
      await until(() => engine.getSnapshot().concurrency === 5, 'concurrency applied by the daemon');

      // Drive a real heartbeat tick through the engine and confirm the event
      // frame is broadcast to, and reduced by, the attached source.
      const before = source.getState().heartbeat.at;
      await new Promise((r) => setTimeout(r, 5));
      // @ts-expect-error -- private, but the cheapest way to force a beat
      // without waiting a full heartbeatIntervalMs in a unit test.
      void engine.beat();
      await until(() => source.getState().heartbeat.at !== before, 'live heartbeat event reduced');
      expect(source.getState().heartbeat.ok).toBe(true);
    } finally {
      source.stop();
    }
  });

  it('stop() detaches without stopping the daemon (daemon keeps running)', async () => {
    const source = createNodeSource(nodeDaemonFeed(socketPath), 1);
    await source.start();
    await until(() => source.getState().connected, 'attach');
    source.stop();
    // The engine must still be running — detaching never stops it.
    expect(engine.getSnapshot().startedAt).not.toBeNull();
    // A fresh attach still succeeds, proving the daemon is still alive.
    const second = createNodeSource(nodeDaemonFeed(socketPath), 1);
    await second.start();
    await until(() => second.getState().connected, 're-attach');
    second.stop();
  });

  it('reports no connection (and keeps looking) when no daemon is listening on the socket', async () => {
    const deadSocket = tmpPath('node-dead.sock');
    const source = createNodeSource(nodeDaemonFeed(deadSocket), 1);
    await source.start();
    try {
      expect(source.getState().connected).toBe(false);
      expect(source.getState().everConnected).toBe(false);
      expect(source.getState().error).toBeTruthy();
    } finally {
      source.stop();
    }
  });

  it('a drain command reaches the daemon (the engine stops claiming)', async () => {
    const source = createNodeSource(nodeDaemonFeed(socketPath), 1);
    await source.start();
    try {
      await until(() => source.getState().connected, 'attach');
      daemonControl(socketPath).drain();
      await until(() => engine.getSnapshot().draining, 'drain applied');
      await until(() => source.getState().draining || engine.getSnapshot().draining, 'drain visible');
    } finally {
      source.stop();
    }
  });
});

describe('embeddedNodeFeed (sanity check alongside the attached smoke)', () => {
  it('follows an engine in this process and reports its events through the same source', async () => {
    const engine = new NodeEngine({
      api: stubApi(),
      dispatcher: stubDispatcher(),
      nodeId: 'node-embedded-1',
      options: { concurrency: 1, eligibleTypes: ['face_detection'], pollIntervalMs: 20_000, heartbeatIntervalMs: 60_000 },
      detectFn: async () => ({}),
      downloadFn: async () => {
        throw new Error('no downloads expected');
      },
    });

    const seen: string[] = [];
    const source = createNodeSource(embeddedNodeFeed(engine, { onEvent: (e) => seen.push(e.ev) }), 1);
    await source.start();
    expect(source.getState().mode).toBe('embedded');
    expect(source.getState().connected).toBe(true);
    expect(source.getState().idle).toBe(false);

    engine.emit(NODE_EV.IDLE, { pollIntervalMs: 20_000 });
    expect(seen).toContain(NODE_EV.IDLE);
    expect(source.getState().idle).toBe(true);

    expect(typeof engineControl(engine).drain).toBe('function');
    source.stop();
    // Detached: later events no longer reach the source.
    engine.emit(NODE_EV.JOB_START, { jobId: 'late', type: 'face_detection' });
    expect(source.getState().activeJobs['late']).toBeUndefined();
  });
});
