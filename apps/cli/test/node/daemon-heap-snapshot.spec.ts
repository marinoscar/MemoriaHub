/**
 * test/node/daemon-heap-snapshot.spec.ts — The `heap-snapshot` IPC command
 * (issue #156).
 *
 * `memoriahub node heap-snapshot` exists so an operator can serialize the heap
 * of a LIVE, already-leaking daemon — restarting it to add a diagnostic flag
 * would discard exactly the accumulated state that names the retainer. This
 * spec drives the real daemon host over a real unix socket (mirroring
 * test/tui/dashboard-attach-smoke.spec.ts) with the snapshot writer injected,
 * so the protocol is exercised without serializing the Jest heap to disk.
 *
 * Covered:
 *   1. A successful snapshot replies { kind:'ack', cmd:'heap-snapshot', path }.
 *   2. A refused/failed snapshot replies { kind:'error' } with the reason, and
 *      the daemon keeps serving (a failed diagnostic must never wedge the
 *      worker).
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { startDaemonHost, type DaemonHost } from '../../src/node/daemon.js';
import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import { connectToDaemon, type DaemonMessage } from '../../src/node/ipc-client.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';
import type { NodeLogger } from '../../src/node/logger.js';
import type { HeapSnapshotResult } from '../../src/node/heap-snapshot.js';

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

function stubLogger(): NodeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logPath: '(stub)',
    log: (level, fields) => lines.push(JSON.stringify({ level, ...fields })),
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
    tail: (n) => lines.slice(-n),
  };
}

function tmpPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-daemon-heap-')), name);
}

/** Send one command and resolve with the first ack/error frame. */
async function sendCommand(socketPath: string, cmd: Record<string, unknown>): Promise<DaemonMessage> {
  const client = await connectToDaemon(socketPath, 2000);
  try {
    client.send(cmd);
    return await client.waitFor((m) => m.kind === 'ack' || m.kind === 'error', 3000);
  } finally {
    client.close();
  }
}

describe('daemon heap-snapshot command', () => {
  let engine: NodeEngine;
  let host: DaemonHost;
  let socketPath: string;
  let logger: ReturnType<typeof stubLogger>;
  let heapSnapshotFn: jest.Mock<() => HeapSnapshotResult>;

  async function startHost(
    result: HeapSnapshotResult,
    hostOpts: { maxClientBacklogBytes?: number } = {},
  ): Promise<void> {
    socketPath = tmpPath('node.sock');
    logger = stubLogger();
    heapSnapshotFn = jest.fn<() => HeapSnapshotResult>(() => result);

    engine = new NodeEngine({
      api: stubApi(),
      dispatcher: stubDispatcher(),
      nodeId: 'node-heapsnap-1',
      options: {
        concurrency: 1,
        eligibleTypes: ['face_detection'],
        pollIntervalMs: 20_000,
        heartbeatIntervalMs: 60_000,
      },
      detectFn: async () => ({}),
      downloadFn: async () => {
        throw new Error('no downloads expected in this test');
      },
    });

    host = await startDaemonHost(engine, logger, {
      socketPath,
      pidPath: tmpPath('node.pid'),
      persistConcurrency: () => {},
      exit: () => {},
      heapSnapshotFn: heapSnapshotFn as never,
      ...hostOpts,
    });

    void engine.start();
    await new Promise<void>((resolve) => engine.once(NODE_EV.HEARTBEAT_OK, () => resolve()));
  }

  afterEach(async () => {
    await engine.stop('test-cleanup');
    await host.close();
  });

  it('acks with the snapshot path on success and logs it', async () => {
    await startHost({
      ok: true,
      path: '/tmp/heap-manual-1-2026-08-08T00-00-00-000Z.heapsnapshot',
      bytes: 4096,
      durationMs: 12,
    });

    const reply = await sendCommand(socketPath, { cmd: 'heap-snapshot' });

    expect(reply.kind).toBe('ack');
    expect(reply['cmd']).toBe('heap-snapshot');
    expect(reply['path']).toBe('/tmp/heap-manual-1-2026-08-08T00-00-00-000Z.heapsnapshot');
    expect(reply['bytes']).toBe(4096);
    expect(heapSnapshotFn).toHaveBeenCalledTimes(1);
    expect(logger.lines.some((l) => l.includes('heap-snapshot'))).toBe(true);
  });

  it('replies with an error when the snapshot is refused, and keeps serving', async () => {
    await startHost({
      ok: false,
      skipped: 'insufficient-disk',
      freeBytes: 1024 * 1024,
      requiredBytes: 8 * 1024 * 1024,
    });

    const reply = await sendCommand(socketPath, { cmd: 'heap-snapshot' });
    expect(reply.kind).toBe('error');
    expect(String(reply['message'])).toContain('not enough free disk');

    // The daemon must still answer subsequent commands — a failed diagnostic
    // is not allowed to take the control plane down with it.
    const status = await sendCommand(socketPath, { cmd: 'set-concurrency', value: 3 });
    expect(status.kind).toBe('ack');
    expect(engine.getSnapshot().concurrency).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Unresponsive-client backpressure (issue #156)
  // ---------------------------------------------------------------------------

  it('drops a client whose write backlog exceeds the cap instead of buffering forever', async () => {
    // A client that stops reading does not make write() fail — Node queues the
    // frames on the heap. With several frames emitted per job, an unnoticed
    // stalled reader is a job-count-linear retainer, so the daemon must shed it.
    await startHost(
      { ok: true, path: '/tmp/unused.heapsnapshot', bytes: 0, durationMs: 0 },
      { maxClientBacklogBytes: 4096 },
    );

    // Raw socket, never read from: `data` is deliberately not consumed and the
    // stream is paused, so the daemon's writes back up.
    const raw = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', () => resolve());
      raw.once('error', reject);
    });
    raw.pause();

    // Emit enough large frames to overflow the kernel buffer and push the
    // daemon's own writable queue past the (tiny, injected) cap.
    const bigError = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 64; i += 1) {
      engine.emit(NODE_EV.JOB_ERROR, {
        jobId: `job-${i}`,
        type: 'face_detection',
        error: bigError,
        willRetry: true,
      });
    }

    // Assert on the daemon's own log rather than the client's 'close': a
    // paused readable with buffered data does not emit 'close' until that data
    // is consumed, so the peer is the wrong place to observe the drop.
    await new Promise((r) => setTimeout(r, 50));
    expect(logger.lines.some((l) => l.includes('dropping unresponsive ipc client'))).toBe(true);
    raw.destroy();

    // Shedding the stalled client must not disturb the control plane.
    const reply = await sendCommand(socketPath, { cmd: 'set-concurrency', value: 2 });
    expect(reply.kind).toBe('ack');
  }, 15_000);
});
