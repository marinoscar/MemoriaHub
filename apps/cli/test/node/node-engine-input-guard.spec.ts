/**
 * test/node/node-engine-input-guard.spec.ts
 *
 * Unit tests for the INPUT_REQUIRED_TYPES guard in NodeEngine.processJob
 * (apps/cli/src/node/node-engine.ts). Before this guard existed, a claimed
 * job whose compute reads the downloaded input file (face_detection,
 * video_face_detection, duplicate_detection, metadata_extraction,
 * social_media_detection, thumbnail_regen, auto_tagging) but whose claim
 * carried `inputUrl: null` (the server could not presign the source object)
 * was dispatched to compute with an empty-string path, surfacing as the
 * opaque `ENOENT: no such file or directory, open ''`. The fix fails such
 * jobs cleanly BEFORE calling compute, with a descriptive error, so the
 * server requeues them instead.
 *
 * Input-less job types (geocode, and the global thumbnail_repair sweep)
 * are NOT in INPUT_REQUIRED_TYPES and must keep dispatching to compute with
 * an empty input path when inputUrl is null — this is normal, not a bug.
 *
 * Mirrors the stubbed ApiClient + ComputeDispatcher harness used by
 * test/node/engine-snapshot.spec.ts and test/node/node-engine-failure.spec.ts
 * — no network, no real filesystem downloads.
 */

import { NodeEngine } from '../../src/node/node-engine.js';
import { NODE_EV } from '../../src/node/node-events.js';
import type { ApiClient, ClaimedNodeJob } from '../../src/api.js';
import type { ComputeDispatcher } from '../../src/node/capabilities.js';

/** Build a claimed job, optionally with a presigned inputUrl. */
function claim(id: string, type: string, inputUrl: string | null = null): ClaimedNodeJob {
  return { job: { id, type }, inputUrl, params: {} };
}

interface FailureCall {
  nodeId: string;
  jobId: string;
  body: { error: string; willRetry?: boolean };
}

interface ComputeCall {
  type: string;
  inputPath: string;
}

interface DownloadCall {
  url: string;
  destPath: string;
}

interface StubResult {
  api: ApiClient;
  dispatcher: ComputeDispatcher;
  failureCalls: FailureCall[];
  computeCalls: ComputeCall[];
  downloadCalls: DownloadCall[];
  submitCalls: number;
}

/**
 * Stub API + dispatcher: serves one claim batch, records every downstream
 * call the engine makes so each test can assert on call presence/absence
 * and exact arguments.
 */
function stubHarness(batch: ClaimedNodeJob[]): StubResult {
  let served = false;
  const failureCalls: FailureCall[] = [];
  const computeCalls: ComputeCall[] = [];
  const downloadCalls: DownloadCall[] = [];
  let submitCalls = 0;

  const api = {
    claimNodeJobs: async () => {
      if (served) return { jobs: [] };
      served = true;
      return { jobs: batch };
    },
    heartbeatNode: async () => ({}),
    deregisterNode: async () => ({}),
    renewLease: async () => ({}),
    submitJobResult: async () => {
      submitCalls += 1;
      return {};
    },
    reportJobFailure: async (nodeId: string, jobId: string, body: FailureCall['body']) => {
      failureCalls.push({ nodeId, jobId, body });
      return {};
    },
  } as unknown as ApiClient;

  const dispatcher = {
    compute: async (type: string, inputPath: string) => {
      computeCalls.push({ type, inputPath });
      return { ok: true };
    },
  } as unknown as ComputeDispatcher;

  return { api, dispatcher, failureCalls, computeCalls, downloadCalls, submitCalls: 0 };
}

function buildEngine(
  batch: ClaimedNodeJob[],
  eligibleTypes: string[],
  downloadCalls: DownloadCall[],
): { engine: NodeEngine; stub: StubResult } {
  const stub = stubHarness(batch);
  const engine = new NodeEngine({
    api: stub.api,
    dispatcher: stub.dispatcher,
    nodeId: 'node-1',
    options: {
      concurrency: 1,
      eligibleTypes,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    },
    detectFn: async () => ({}),
    downloadFn: async (url: string, destPath: string) => {
      downloadCalls.push({ url, destPath });
      return 1234;
    },
    tmpDir: () => '/tmp/node-engine-input-guard-test',
  });
  return { engine, stub };
}

async function runUntilIdle(engine: NodeEngine): Promise<void> {
  await new Promise<void>((resolve) => {
    engine.once(NODE_EV.IDLE, () => resolve());
    void engine.start();
  });
}

describe('NodeEngine INPUT_REQUIRED_TYPES guard', () => {
  it('face_detection with inputUrl:null fails cleanly WITHOUT calling compute or downloadFn', async () => {
    const downloadCalls: DownloadCall[] = [];
    const errorEvents: Array<{ jobId: string; type: string; error: string; willRetry: boolean }> = [];
    const { engine, stub } = buildEngine(
      [claim('j1', 'face_detection', null)],
      ['face_detection'],
      downloadCalls,
    );
    engine.on(NODE_EV.JOB_ERROR, (payload) => errorEvents.push(payload));

    await runUntilIdle(engine);
    await engine.stop('test');

    // No download attempted, no compute call — the guard fires before dispatch.
    expect(downloadCalls).toHaveLength(0);
    expect(stub.computeCalls).toHaveLength(0);

    // Failure reported with willRetry:true and a descriptive message.
    expect(stub.failureCalls).toHaveLength(1);
    expect(stub.failureCalls[0]?.nodeId).toBe('node-1');
    expect(stub.failureCalls[0]?.jobId).toBe('j1');
    expect(stub.failureCalls[0]?.body.willRetry).toBe(true);
    expect(stub.failureCalls[0]?.body.error).toContain('input bytes unavailable');
    expect(stub.failureCalls[0]?.body.error).toContain('j1');
    expect(stub.failureCalls[0]?.body.error).toContain('face_detection');
    // Must NOT be the opaque raw ENOENT that motivated this fix.
    expect(stub.failureCalls[0]?.body.error).not.toMatch(/ENOENT/);
    expect(stub.failureCalls[0]?.body.error).not.toMatch(/open ''/);

    // JOB_ERROR event emitted with the same descriptive message.
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.jobId).toBe('j1');
    expect(errorEvents[0]?.type).toBe('face_detection');
    expect(errorEvents[0]?.willRetry).toBe(true);
    expect(errorEvents[0]?.error).toContain('input bytes unavailable');
  });

  it.each(['video_face_detection', 'duplicate_detection', 'metadata_extraction', 'social_media_detection', 'thumbnail_regen', 'auto_tagging'])(
    '%s with inputUrl:null also fails cleanly without calling compute',
    async (type) => {
      const downloadCalls: DownloadCall[] = [];
      const { engine, stub } = buildEngine([claim('j1', type, null)], [type], downloadCalls);

      await runUntilIdle(engine);
      await engine.stop('test');

      expect(downloadCalls).toHaveLength(0);
      expect(stub.computeCalls).toHaveLength(0);
      expect(stub.failureCalls).toHaveLength(1);
      expect(stub.failureCalls[0]?.body.error).toContain('input bytes unavailable');
    },
  );

  it('geocode with inputUrl:null still dispatches to compute with an empty input path and succeeds', async () => {
    const downloadCalls: DownloadCall[] = [];
    const doneEvents: Array<{ jobId: string; type: string; submitted: boolean }> = [];
    const { engine, stub } = buildEngine([claim('j1', 'geocode', null)], ['geocode'], downloadCalls);
    engine.on(NODE_EV.JOB_DONE, (payload) => doneEvents.push(payload));

    await runUntilIdle(engine);
    await engine.stop('test');

    // No download for an input-less job type.
    expect(downloadCalls).toHaveLength(0);

    // compute WAS called, with an empty-string input path — this is the
    // pre-existing, correct behaviour for input-less job types and must not
    // regress when the input-required guard was added.
    expect(stub.computeCalls).toHaveLength(1);
    expect(stub.computeCalls[0]).toEqual({ type: 'geocode', inputPath: '' });

    // No failure reported; job completes successfully.
    expect(stub.failureCalls).toHaveLength(0);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.jobId).toBe('j1');
    expect(doneEvents[0]?.submitted).toBe(true);
  });

  it('face_detection WITH a non-null inputUrl downloads to the temp path and calls compute with that path (regression guard)', async () => {
    const downloadCalls: DownloadCall[] = [];
    const doneEvents: Array<{ jobId: string; type: string; submitted: boolean }> = [];
    const { engine, stub } = buildEngine(
      [claim('j1', 'face_detection', 'https://storage.example.com/signed/j1')],
      ['face_detection'],
      downloadCalls,
    );
    engine.on(NODE_EV.JOB_DONE, (payload) => doneEvents.push(payload));

    await runUntilIdle(engine);
    await engine.stop('test');

    // Download WAS attempted with the presigned URL.
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]?.url).toBe('https://storage.example.com/signed/j1');
    expect(downloadCalls[0]?.destPath).toMatch(/^\/tmp\/node-engine-input-guard-test\/memoriahub-node-j1-/);

    // compute was called with the exact same temp path the download wrote to.
    expect(stub.computeCalls).toHaveLength(1);
    expect(stub.computeCalls[0]?.type).toBe('face_detection');
    expect(stub.computeCalls[0]?.inputPath).toBe(downloadCalls[0]?.destPath);

    expect(stub.failureCalls).toHaveLength(0);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.submitted).toBe(true);
  });
});
