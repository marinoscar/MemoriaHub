/**
 * test/node/node-engine-concurrency.spec.ts
 *
 * Unit tests for the node-concurrency fixes in node-engine.ts (issue #105):
 *
 *  1. The claim loop was rewritten from a batch-drain barrier (claim a batch,
 *     Promise.all() it, only claim again once EVERY job in the batch finished)
 *     into a continuous top-up pool that tracks in-flight jobs and claims only
 *     as many new jobs as there are free slots, dispatching each immediately
 *     without waiting for the rest of the batch. This test proves a single
 *     slow straggler no longer throttles the node down to ~1 effective
 *     concurrent job — the other slots keep being refilled with fresh work.
 *
 *  2. beat() now includes the live `concurrencyCap` in every heartbeat body,
 *     and setConcurrency() fires an immediate best-effort heartbeat so a
 *     runtime concurrency change reaches the server within ~1s instead of
 *     waiting for the next ~20s heartbeat tick.
 *
 * Harness mirrors engine-snapshot.spec.ts / node-engine-failure.spec.ts: a
 * fully stubbed ApiClient + ComputeDispatcher, no network, no real downloads.
 */

import { jest } from '@jest/globals';
import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import type { ApiClient, ClaimedNodeJob, NodeClaimBody, NodeHeartbeatBody } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';

/** Build a claimed job with a null inputUrl (job type is a custom test type,
 *  not one of node-engine.ts's INPUT_REQUIRED_TYPES, so no download occurs). */
function claim(id: string, type: string): ClaimedNodeJob {
  return { job: { id, type }, inputUrl: null, params: {} };
}

describe('NodeEngine continuous top-up pool (issue #105)', () => {
  it('keeps the concurrency cap full with fresh jobs while one slow straggler blocks a slot', async () => {
    const CAP = 4;

    // The test controls exactly when the "slow" job's compute resolves.
    let resolveSlow: (() => void) | null = null;
    const slowPromise = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });

    // A deep backlog: one deliberately-stuck job plus a large supply of fast
    // jobs — mimics the server always having more eligible work available
    // than the node has open slots for.
    const backlog: ClaimedNodeJob[] = [
      claim('slow-1', 'slow'),
      ...Array.from({ length: 40 }, (_, i) => claim(`fast-${i}`, 'fast')),
    ];

    const claimCalls: NodeClaimBody[] = [];

    const api = {
      // Mimics the real server: honors the requested `max` (the node's open
      // slot count) and returns up to that many jobs from the queue.
      claimNodeJobs: async (_nodeId: string, body: NodeClaimBody) => {
        claimCalls.push(body);
        const max = body.max ?? 0;
        const batch = backlog.splice(0, max);
        return { jobs: batch };
      },
      heartbeatNode: async () => ({}),
      deregisterNode: async () => ({}),
      renewLease: async () => ({}),
      submitJobResult: async () => ({}),
      reportJobFailure: async () => ({}),
    } as unknown as ApiClient;

    const dispatcher = {
      compute: async (type: string) => {
        if (type === 'slow') {
          await slowPromise;
          return { ok: true };
        }
        // Fast jobs resolve promptly so the pool churns through the backlog.
        return { ok: true };
      },
    } as unknown as ComputeDispatcher;

    const engine = new NodeEngine({
      api,
      dispatcher,
      nodeId: 'node-1',
      options: {
        concurrency: CAP,
        eligibleTypes: ['slow', 'fast'],
        pollIntervalMs: 5,
        heartbeatIntervalMs: 60_000,
      },
      detectFn: async () => ({}),
    });

    const startedJobIds = new Set<string>();
    engine.on(NODE_EV.JOB_START, (payload) => startedJobIds.add(payload.jobId));

    // Wait, driven by JOB_START events (no fixed sleeps), until the pool has
    // (a) reached the concurrency cap, AND (b) processed well beyond a single
    // batch's worth of jobs — only possible if the loop keeps topping up
    // rather than barrier-waiting on the whole first claimed batch to finish.
    // A pre-fix batch-drain barrier would claim once (<= CAP jobs), then
    // await Promise.all() on that batch before claiming again — since
    // "slow-1" never resolves during this wait, startedJobIds would get stuck
    // at CAP and claimCalls would never exceed 1.
    const reachedSteadyStateWhileBlocked = new Promise<void>((resolve) => {
      const check = () => {
        const snap = engine.getSnapshot();
        if (snap.activeJobs.length === CAP && startedJobIds.size >= 12) {
          engine.off(NODE_EV.JOB_START, check);
          resolve();
        }
      };
      engine.on(NODE_EV.JOB_START, check);
    });

    void engine.start();
    await reachedSteadyStateWhileBlocked;

    // Proof #1: multiple independent claim rounds happened BEFORE the slow
    // job resolved — impossible under the old batch-barrier loop.
    expect(claimCalls.length).toBeGreaterThan(1);

    // Proof #2: the pool is still full at the cap even though the slow job
    // has not resolved — the other CAP-1 slots are continuously refilled
    // with fresh work instead of idling behind the straggler.
    const snap = engine.getSnapshot();
    expect(snap.activeJobs).toHaveLength(CAP);
    expect(snap.activeJobs.some((j) => j.jobId === 'slow-1')).toBe(true);

    // Every claim after the first requested no more than the currently-free
    // slot count (never over-claims beyond open capacity).
    for (const body of claimCalls) {
      expect(body.max).toBeLessThanOrEqual(CAP);
    }

    // Let the straggler finish and drain the engine cleanly.
    resolveSlow?.();
    await engine.stop('test');

    expect(engine.getSnapshot().activeJobs).toEqual([]);
  });
});

describe('NodeEngine heartbeat concurrency sync', () => {
  it('sends the live concurrency cap on every heartbeat, and setConcurrency() triggers an immediate new heartbeat', async () => {
    const heartbeatCalls: Array<{ nodeId: string; body: NodeHeartbeatBody }> = [];

    const api = {
      claimNodeJobs: async () => ({ jobs: [] }),
      heartbeatNode: async (nodeId: string, body: NodeHeartbeatBody) => {
        heartbeatCalls.push({ nodeId, body });
        return {};
      },
      deregisterNode: async () => ({}),
      renewLease: async () => ({}),
      submitJobResult: async () => ({}),
      reportJobFailure: async () => ({}),
    } as unknown as ApiClient;

    const dispatcher = {
      compute: async () => ({ ok: true }),
    } as unknown as ComputeDispatcher;

    const engine = new NodeEngine({
      api,
      dispatcher,
      nodeId: 'node-1',
      options: {
        concurrency: 3,
        eligibleTypes: [],
        pollIntervalMs: 5,
        // Long enough that the ticker itself never fires during this test —
        // any second heartbeat we observe must come from setConcurrency().
        heartbeatIntervalMs: 60_000,
      },
      detectFn: async () => ({}),
    });

    const idle = new Promise<void>((resolve) => {
      engine.once(NODE_EV.IDLE, () => resolve());
    });
    void engine.start();
    await idle;

    // start() sends one initial heartbeat before entering the claim loop.
    expect(heartbeatCalls).toHaveLength(1);
    expect(heartbeatCalls[0]?.nodeId).toBe('node-1');
    expect(heartbeatCalls[0]?.body.concurrency).toBe(3);

    const secondHeartbeat = new Promise<void>((resolve) => {
      engine.once(NODE_EV.HEARTBEAT_OK, () => resolve());
    });

    engine.setConcurrency(7);

    // (a) the snapshot reflects the new cap immediately, synchronously.
    expect(engine.getSnapshot().concurrency).toBe(7);

    // (b) a NEW heartbeat was fired as a side effect, carrying the new value —
    // not waiting for the 60s ticker.
    await secondHeartbeat;
    expect(heartbeatCalls).toHaveLength(2);
    expect(heartbeatCalls[1]?.nodeId).toBe('node-1');
    expect(heartbeatCalls[1]?.body.concurrency).toBe(7);

    await engine.stop('test');
  });
});

describe('NodeEngine heartbeat face-provider detectFn wiring', () => {
  it('invokes detectFn with the configured comprefaceUrl on every beat', async () => {
    const api = {
      claimNodeJobs: async () => ({ jobs: [] }),
      heartbeatNode: async () => ({}),
      deregisterNode: async () => ({}),
      renewLease: async () => ({}),
      submitJobResult: async () => ({}),
      reportJobFailure: async () => ({}),
    } as unknown as ApiClient;

    const dispatcher = {
      compute: async () => ({ ok: true }),
    } as unknown as ComputeDispatcher;

    const detectFn = jest.fn(async () => ({}));

    const engine = new NodeEngine({
      api,
      dispatcher,
      nodeId: 'node-1',
      options: {
        concurrency: 1,
        eligibleTypes: [],
        pollIntervalMs: 5,
        heartbeatIntervalMs: 60_000,
        faceProvider: 'compreface',
        comprefaceUrl: 'http://localhost:4242',
      },
      detectFn,
    });

    const idle = new Promise<void>((resolve) => {
      engine.once(NODE_EV.IDLE, () => resolve());
    });
    void engine.start();
    await idle;

    // start() triggers one initial beat() before entering the claim loop.
    expect(detectFn).toHaveBeenCalledWith({ comprefaceUrl: 'http://localhost:4242' });

    await engine.stop('test');
  });

  it('invokes detectFn with an undefined comprefaceUrl when the node was not configured for compreface', async () => {
    const api = {
      claimNodeJobs: async () => ({ jobs: [] }),
      heartbeatNode: async () => ({}),
      deregisterNode: async () => ({}),
      renewLease: async () => ({}),
      submitJobResult: async () => ({}),
      reportJobFailure: async () => ({}),
    } as unknown as ApiClient;

    const dispatcher = {
      compute: async () => ({ ok: true }),
    } as unknown as ComputeDispatcher;

    const detectFn = jest.fn(async () => ({}));

    const engine = new NodeEngine({
      api,
      dispatcher,
      nodeId: 'node-1',
      options: {
        concurrency: 1,
        eligibleTypes: [],
        pollIntervalMs: 5,
        heartbeatIntervalMs: 60_000,
        // faceProvider/comprefaceUrl intentionally omitted (default 'human').
      },
      detectFn,
    });

    const idle = new Promise<void>((resolve) => {
      engine.once(NODE_EV.IDLE, () => resolve());
    });
    void engine.start();
    await idle;

    expect(detectFn).toHaveBeenCalledWith({ comprefaceUrl: undefined });

    await engine.stop('test');
  });
});
