/**
 * test/node/engine-snapshot.spec.ts
 *
 * Unit tests for the NodeEngine observability layer added for the daemon:
 * getSnapshot() (counters, history ring buffer, active jobs, uptime anchor),
 * setConcurrency() live adjustment, and drain() vs stop() semantics.
 *
 * The engine runs against a fully stubbed ApiClient and ComputeDispatcher —
 * no network, no downloads (inputUrl: null), no real capability probing.
 */

import { NodeEngine, type EngineSnapshot } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';

/**
 * Build a claimed job. Defaults to `inputUrl: null`. face_detection is one
 * of the INPUT_REQUIRED_TYPES in node-engine.ts — a null inputUrl now makes
 * processJob fail BEFORE dispatch (see node-engine-input-guard.spec.ts), so
 * any face_detection case here that means to exercise compute must pass a
 * non-null inputUrl explicitly.
 */
function claim(id: string, type: string, inputUrl: string | null = null): ClaimedNodeJob {
  return { job: { id, type }, inputUrl, params: {} };
}

interface StubApi {
  api: ApiClient;
  calls: { deregister: number; heartbeat: number };
}

/** Stub API: serves the given claim batches once each, then empty forever. */
function stubApi(batches: ClaimedNodeJob[][]): StubApi {
  let call = 0;
  const calls = { deregister: 0, heartbeat: 0 };
  const api = {
    claimNodeJobs: async () => ({ jobs: batches[call++] ?? [] }),
    heartbeatNode: async () => {
      calls.heartbeat += 1;
      return {};
    },
    deregisterNode: async () => {
      calls.deregister += 1;
      return {};
    },
    renewLease: async () => ({}),
    submitJobResult: async () => ({}),
    reportJobFailure: async () => ({}),
  } as unknown as ApiClient;
  return { api, calls };
}

/** Stub dispatcher: succeeds for every type except ones prefixed "bad". */
function stubDispatcher(): ComputeDispatcher {
  return {
    compute: async (jobType: string) => {
      if (jobType.startsWith('bad')) throw new Error(`compute failed for ${jobType}`);
      return { ok: true };
    },
  } as unknown as ComputeDispatcher;
}

function buildEngine(batches: ClaimedNodeJob[][], concurrency = 2): NodeEngine {
  return new NodeEngine({
    api: stubApi(batches).api,
    dispatcher: stubDispatcher(),
    nodeId: 'node-1',
    options: {
      concurrency,
      eligibleTypes: ['face_detection'],
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    },
    detectFn: async () => ({}),
    // No-op: face_detection cases below now pass a non-null inputUrl (it's
    // an INPUT_REQUIRED_TYPES entry) so the guard lets them reach the
    // dispatcher, which requires downloadFn to succeed rather than throw.
    downloadFn: async () => 0,
  });
}

/** Start the engine, wait for the first IDLE after work is done, snapshot. */
async function runUntilIdle(engine: NodeEngine): Promise<void> {
  await new Promise<void>((resolve) => {
    engine.once(NODE_EV.IDLE, () => resolve());
    void engine.start();
  });
}

describe('NodeEngine snapshot & counters', () => {
  it('tracks claimed/succeeded/failed counters and the history ring', async () => {
    const engine = buildEngine([
      [
        claim('j1', 'face_detection', 'https://storage.example.com/signed/j1'),
        claim('j2', 'bad_type'),
        claim('j3', 'face_detection', 'https://storage.example.com/signed/j3'),
      ],
    ]);
    await runUntilIdle(engine);
    const snap: EngineSnapshot = engine.getSnapshot();
    await engine.stop('test');

    expect(snap.nodeId).toBe('node-1');
    expect(snap.startedAt).not.toBeNull();
    expect(snap.counters).toEqual({ claimed: 3, succeeded: 2, failed: 1 });
    expect(snap.activeJobs).toEqual([]); // everything finished before idle
    expect(snap.history).toHaveLength(3);

    const byId = new Map(snap.history.map((h) => [h.jobId, h]));
    expect(byId.get('j1')).toMatchObject({ status: 'done', type: 'face_detection' });
    expect(byId.get('j2')).toMatchObject({
      status: 'error',
      error: 'compute failed for bad_type',
    });
    expect(byId.get('j3')).toMatchObject({ status: 'done' });
    for (const h of snap.history) {
      expect(typeof h.finishedAt).toBe('string');
      expect(typeof h.durationMs).toBe('number');
    }
  });

  it('caps the history ring buffer at 50 entries, evicting the oldest', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) =>
      claim(`j${i}`, 'face_detection', `https://storage.example.com/signed/j${i}`),
    );
    const engine = buildEngine([jobs], 8);
    await runUntilIdle(engine);
    const snap = engine.getSnapshot();
    await engine.stop('test');

    expect(snap.counters.succeeded).toBe(60);
    expect(snap.history).toHaveLength(50);
    // The 10 oldest completions were evicted; all 60 ids minus history = 10.
    const kept = new Set(snap.history.map((h) => h.jobId));
    expect(kept.size).toBe(50);
  });

  it('setConcurrency updates the snapshot immediately and clamps to >= 1', () => {
    const engine = buildEngine([]);
    expect(engine.getSnapshot().concurrency).toBe(2);
    engine.setConcurrency(5);
    expect(engine.getSnapshot().concurrency).toBe(5);
    engine.setConcurrency(0);
    expect(engine.getSnapshot().concurrency).toBe(1);
  });

  it('drain() stops the claim loop without deregistering; stop() deregisters', async () => {
    const { api, calls } = stubApi([]);
    const engine = new NodeEngine({
      api,
      dispatcher: stubDispatcher(),
      nodeId: 'node-1',
      options: {
        concurrency: 1,
        eligibleTypes: [],
        pollIntervalMs: 5,
        heartbeatIntervalMs: 60_000,
      },
      detectFn: async () => ({}),
    });

    const startPromise = new Promise<void>((resolve) => {
      engine.once(NODE_EV.IDLE, () => resolve());
      void engine.start();
    });
    await startPromise;

    engine.drain();
    expect(engine.getSnapshot().draining).toBe(true);
    // Give the loop a tick to observe draining and exit.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.deregister).toBe(0);

    const stopped = new Promise<void>((resolve) => {
      engine.once(NODE_EV.STOPPED, () => resolve());
    });
    await engine.stop('test');
    await stopped;
    expect(calls.deregister).toBe(1);
  });

  it('records lastHeartbeatAt after a successful beat', async () => {
    const engine = buildEngine([]);
    await runUntilIdle(engine);
    const snap = engine.getSnapshot();
    await engine.stop('test');
    expect(snap.lastHeartbeatAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(snap.lastHeartbeatAt as string))).toBe(false);
  });
});
