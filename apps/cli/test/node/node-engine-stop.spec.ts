/**
 * test/node/node-engine-stop.spec.ts
 *
 * Unit tests for NodeEngine.stop()'s optional `{ deregister?: boolean }`
 * second argument (apps/cli/src/node/node-engine.ts), added for headless/
 * container lifecycles: a SIGTERM'd container must drain in-flight work but
 * KEEP its server-side node row so the restarted replica re-attaches via the
 * idempotent register endpoint, while every existing caller (explicit
 * `node stop`, IPC stop, tests) keeps the default deregister-on-stop
 * behaviour unchanged.
 *
 * Mirrors the stubbed ApiClient + ComputeDispatcher harness used by
 * test/node/engine-snapshot.spec.ts and node-engine-failure.spec.ts —
 * no network, no real filesystem downloads.
 */

import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';

interface Harness {
  api: ApiClient;
  dispatcher: ComputeDispatcher;
  deregisterCalls: string[];
  computeCalls: string[];
}

/** Stub API + dispatcher: serves one claim batch, records deregister/compute calls. */
function stubHarness(batch: ClaimedNodeJob[]): Harness {
  let served = false;
  const deregisterCalls: string[] = [];
  const computeCalls: string[] = [];

  const api = {
    claimNodeJobs: async () => {
      if (served) return { jobs: [] };
      served = true;
      return { jobs: batch };
    },
    heartbeatNode: async () => ({}),
    deregisterNode: async (nodeId: string) => {
      deregisterCalls.push(nodeId);
      return {};
    },
    renewLease: async () => ({}),
    submitJobResult: async () => ({}),
    reportJobFailure: async () => ({}),
  } as unknown as ApiClient;

  const dispatcher = {
    compute: async (type: string) => {
      computeCalls.push(type);
      return { ok: true };
    },
  } as unknown as ComputeDispatcher;

  return { api, dispatcher, deregisterCalls, computeCalls };
}

function buildEngine(batch: ClaimedNodeJob[]): { engine: NodeEngine; harness: Harness } {
  const harness = stubHarness(batch);
  const engine = new NodeEngine({
    api: harness.api,
    dispatcher: harness.dispatcher,
    nodeId: 'node-1',
    options: {
      concurrency: 1,
      eligibleTypes: ['geocode'],
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    },
    detectFn: async () => ({}),
    downloadFn: async () => 0,
  });
  return { engine, harness };
}

async function runUntilIdle(engine: NodeEngine): Promise<void> {
  await new Promise<void>((resolve) => {
    engine.once(NODE_EV.IDLE, () => resolve());
    void engine.start();
  });
}

describe('NodeEngine.stop deregister flag', () => {
  it('stop() with no options still deregisters (back-compat default)', async () => {
    const { engine, harness } = buildEngine([]);

    await runUntilIdle(engine);
    await engine.stop('test');

    expect(harness.deregisterCalls).toEqual(['node-1']);
  });

  it('stop(reason, { deregister: true }) deregisters explicitly', async () => {
    const { engine, harness } = buildEngine([]);

    await runUntilIdle(engine);
    await engine.stop('test', { deregister: true });

    expect(harness.deregisterCalls).toEqual(['node-1']);
  });

  it('stop(reason, { deregister: false }) never calls api.deregisterNode but still emits stopped', async () => {
    const { engine, harness } = buildEngine([]);
    const stoppedEvents: Array<{ reason: string }> = [];
    engine.on(NODE_EV.STOPPED, (p) => stoppedEvents.push(p));

    await runUntilIdle(engine);
    await engine.stop('signal', { deregister: false });

    expect(harness.deregisterCalls).toHaveLength(0);
    expect(stoppedEvents).toEqual([{ reason: 'signal' }]);
  });

  it('stop with deregister:false still drains in-flight work before stopping', async () => {
    // geocode is input-less (inputUrl: null is legal) so the claim dispatches
    // straight to the stub dispatcher.
    const { engine, harness } = buildEngine([
      { job: { id: 'j1', type: 'geocode' }, inputUrl: null, params: {} } as ClaimedNodeJob,
    ]);
    const doneEvents: Array<{ jobId: string }> = [];
    engine.on(NODE_EV.JOB_DONE, (p) => doneEvents.push(p));

    await runUntilIdle(engine);
    await engine.stop('signal', { deregister: false });

    // The claimed job ran to completion (drain semantics unchanged)…
    expect(harness.computeCalls).toEqual(['geocode']);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.jobId).toBe('j1');
    // …and the node row was left registered.
    expect(harness.deregisterCalls).toHaveLength(0);
  });
});
