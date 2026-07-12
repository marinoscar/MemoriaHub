/**
 * test/node/node-engine-failure.spec.ts
 *
 * Unit tests for NodeEngine.processJob's failure-reporting path — in
 * particular, the rate-limit classification added so a compute module that
 * throws a `ProviderRateLimitError` (@memoriahub/enrichment-compute/rate-limit)
 * — e.g. auto-tagging hitting Anthropic 429/529, or geocode hitting
 * Nominatim/Google 429/5xx — forwards `{ rateLimited: true, retryAfterMs }`
 * to `POST /nodes/:id/jobs/:jobId/failure` instead of the plain
 * `{ willRetry: true }` body used for every other failure. See
 * apps/cli/test/node/engine-snapshot.spec.ts for the wider NodeEngine test
 * harness this file mirrors (stubbed ApiClient + ComputeDispatcher, no
 * network, no downloads).
 */

import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import { ProviderRateLimitError } from '@memoriahub/enrichment-compute/rate-limit';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';

/**
 * Build a claimed job. Defaults to `inputUrl: null` (no input download) for
 * job types that don't need one (e.g. geocode). auto_tagging is one of the
 * INPUT_REQUIRED_TYPES in node-engine.ts — a null inputUrl now makes
 * processJob fail BEFORE dispatch (see node-engine-input-guard.spec.ts), so
 * any auto_tagging case here that means to exercise the dispatcher/failure
 * path must pass a non-null inputUrl explicitly.
 */
function claim(id: string, type: string, inputUrl: string | null = null): ClaimedNodeJob {
  return { job: { id, type }, inputUrl, params: {} };
}

interface FailureCall {
  nodeId: string;
  jobId: string;
  body: { error: string; willRetry?: boolean; rateLimited?: boolean; retryAfterMs?: number };
}

/** Stub API: serves one claim batch, then empty forever; records reportJobFailure calls. */
function stubApi(batch: ClaimedNodeJob[]): { api: ApiClient; failureCalls: FailureCall[] } {
  let served = false;
  const failureCalls: FailureCall[] = [];
  const api = {
    claimNodeJobs: async () => {
      if (served) return { jobs: [] };
      served = true;
      return { jobs: batch };
    },
    heartbeatNode: async () => ({}),
    deregisterNode: async () => ({}),
    renewLease: async () => ({}),
    submitJobResult: async () => ({}),
    reportJobFailure: async (nodeId: string, jobId: string, body: FailureCall['body']) => {
      failureCalls.push({ nodeId, jobId, body });
      return {};
    },
  } as unknown as ApiClient;
  return { api, failureCalls };
}

/** Stub dispatcher: throws whatever `computeThrows` returns for every job type. */
function stubDispatcher(computeThrows: () => unknown): ComputeDispatcher {
  return {
    compute: async () => {
      throw computeThrows();
    },
  } as unknown as ComputeDispatcher;
}

function buildEngine(batch: ClaimedNodeJob[], computeThrows: () => unknown): { engine: NodeEngine; failureCalls: FailureCall[] } {
  const { api, failureCalls } = stubApi(batch);
  const engine = new NodeEngine({
    api,
    dispatcher: stubDispatcher(computeThrows),
    nodeId: 'node-1',
    options: {
      concurrency: 1,
      eligibleTypes: ['auto_tagging', 'geocode'],
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    },
    detectFn: async () => ({}),
    // No-op: geocode cases keep inputUrl:null (never reaches downloadFn);
    // auto_tagging cases below now pass a non-null inputUrl so the
    // INPUT_REQUIRED_TYPES guard lets them reach the dispatcher, which
    // requires downloadFn to succeed rather than throw.
    downloadFn: async () => 0,
  });
  return { engine, failureCalls };
}

async function runUntilIdle(engine: NodeEngine): Promise<void> {
  await new Promise<void>((resolve) => {
    engine.once(NODE_EV.IDLE, () => resolve());
    void engine.start();
  });
}

describe('NodeEngine rate-limit failure classification', () => {
  it('forwards rateLimited:true and retryAfterMs when the compute module throws ProviderRateLimitError', async () => {
    const { engine, failureCalls } = buildEngine(
      [claim('j1', 'auto_tagging', 'https://storage.example.com/signed/j1')],
      () => new ProviderRateLimitError('Anthropic rate limit / overload (HTTP 429): slow down', 'anthropic', 5000),
    );

    await runUntilIdle(engine);
    await engine.stop('test');

    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]?.body).toEqual({
      error: 'Anthropic rate limit / overload (HTTP 429): slow down',
      willRetry: true,
      rateLimited: true,
      retryAfterMs: 5000,
    });
  });

  it('forwards rateLimited:true with retryAfterMs omitted when the signal carries no retryAfterMs', async () => {
    const { engine, failureCalls } = buildEngine(
      [claim('j1', 'geocode')],
      () => new ProviderRateLimitError('nominatim rate limit / throttle', 'nominatim'),
    );

    await runUntilIdle(engine);
    await engine.stop('test');

    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]?.body).toEqual({
      error: 'nominatim rate limit / throttle',
      willRetry: true,
      rateLimited: true,
    });
    expect(failureCalls[0]?.body.retryAfterMs).toBeUndefined();
  });

  it('omits rateLimited entirely for a plain Error — no regression on the existing failure path', async () => {
    const { engine, failureCalls } = buildEngine(
      [claim('j1', 'auto_tagging', 'https://storage.example.com/signed/j1')],
      () => new Error('some unrelated compute failure'),
    );

    await runUntilIdle(engine);
    await engine.stop('test');

    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]?.body).toEqual({
      error: 'some unrelated compute failure',
      willRetry: true,
    });
    expect(failureCalls[0]?.body.rateLimited).toBeUndefined();
    expect(failureCalls[0]?.body.retryAfterMs).toBeUndefined();
  });

  it('treats a subclass of ProviderRateLimitError (e.g. GeoProviderRateLimitError) the same way', async () => {
    // Mirrors packages/enrichment-compute/src/geo/index.ts's GeoProviderRateLimitError
    // without importing the /geo subpath — proves the engine's classification
    // is `instanceof ProviderRateLimitError`, not a check against the exact class.
    class FakeGeoProviderRateLimitError extends ProviderRateLimitError {}

    const { engine, failureCalls } = buildEngine(
      [claim('j1', 'geocode')],
      () => new FakeGeoProviderRateLimitError('google quota exceeded', 'google', 15_000),
    );

    await runUntilIdle(engine);
    await engine.stop('test');

    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]?.body).toEqual({
      error: 'google quota exceeded',
      willRetry: true,
      rateLimited: true,
      retryAfterMs: 15_000,
    });
  });
});
