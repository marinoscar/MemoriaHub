/**
 * test/tui/dashboard-attach-smoke.spec.ts
 *
 * Headless smoke test proving the tui/node-dashboard-source.ts attached
 * source can really talk to a running daemon: a stub NodeEngine (stub
 * ApiClient + stub ComputeDispatcher, no network, no real compute) is hosted
 * via node/daemon.ts's startDaemonHost on a throwaway unix socket, then
 * createAttachedSource() connects to it exactly the way NodeDashboard.tsx
 * does — no Ink, no pty, just the plain async API.
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
  createAttachedSource,
  EmbeddedDashboardSource,
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

describe('attached dashboard source (headless smoke)', () => {
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

  it('connects, hydrates from the snapshot greeting, and forwards live events', async () => {
    const source = await createAttachedSource(socketPath, 2000);
    try {
      expect(source.mode).toBe('attached');
      expect(source.snapshot).not.toBeNull();
      expect(source.snapshot!.nodeId).toBe('node-smoke-1');
      expect(source.snapshot!.concurrency).toBe(2);
      expect(source.snapshot!.eligibleTypes).toEqual(['face_detection']);
      // The initial heartbeat already landed before we connected.
      expect(source.snapshot!.lastHeartbeatAt).not.toBeNull();

      const events: Array<{ ev: string; payload: unknown }> = [];
      source.onEvent((ev, payload) => events.push({ ev, payload }));

      // Trigger a live concurrency change over the real IPC socket and
      // confirm the underlying engine (source of truth) applied it.
      source.setConcurrency(5);
      await new Promise((r) => setTimeout(r, 200));
      expect(engine.getSnapshot().concurrency).toBe(5);

      // Drive a real heartbeat tick through the engine and confirm the event
      // frame is broadcast to, and dispatched by, the attached source.
      await new Promise<void>((resolve) => {
        engine.once(NODE_EV.HEARTBEAT_OK, () => resolve());
        // @ts-expect-error -- private, but the cheapest way to force a beat
        // without waiting a full heartbeatIntervalMs in a unit test.
        void engine.beat();
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(events.some((e) => e.ev === NODE_EV.HEARTBEAT_OK)).toBe(true);
    } finally {
      source.close();
    }
  });

  it('close() detaches without stopping the daemon (daemon keeps running)', async () => {
    const source = await createAttachedSource(socketPath, 2000);
    source.close();
    // The engine must still be running — attached close() never stops it.
    expect(engine.getSnapshot().startedAt).not.toBeNull();
    // A fresh connection still succeeds, proving the daemon is still alive.
    const second = await createAttachedSource(socketPath, 2000);
    expect(second.mode).toBe('attached');
    second.close();
  });

  it('rejects when no daemon is listening on the socket', async () => {
    const deadSocket = tmpPath('node-dead.sock');
    await expect(createAttachedSource(deadSocket, 300)).rejects.toBeTruthy();
  });
});

describe('EmbeddedDashboardSource (sanity check alongside the attached smoke)', () => {
  it('starts with no snapshot and forwards attached engine events', () => {
    const source = new EmbeddedDashboardSource();
    expect(source.mode).toBe('embedded');
    expect(source.snapshot).toBeNull();
    expect(source.hasEngine).toBe(false);

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
    source.onEvent((ev) => seen.push(ev));
    source.attachEngine(engine);
    expect(source.hasEngine).toBe(true);

    engine.emit(NODE_EV.IDLE, { pollIntervalMs: 20_000 });
    expect(seen).toContain(NODE_EV.IDLE);

    source.releaseEngine();
    expect(source.hasEngine).toBe(false);
  });
});
