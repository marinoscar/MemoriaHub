/**
 * test/tui/node-doctor-sweep.spec.ts
 *
 * Unit tests for the shared sweep function in tui/useNodeDoctorSweep.ts —
 * `runNodeDoctorSweep()`, the plain async function BOTH tui/NodeDoctor.tsx
 * (full screen) and tui/NodeDashboard.tsx (the `[r]` doctor overlay) call.
 * No Ink rendering here (see test/tui/node-dashboard-source.spec.ts for the
 * project's established "pure function, no pty" pattern this mirrors) — only
 * the sweep's data-shaping/aggregation logic and its never-throws error
 * isolation are under test.
 *
 * All four collaborator modules (node/capabilities.ts, node/self-test.ts,
 * node/doctor-checks.ts, node/models.ts) are mocked via
 * jest.unstable_mockModule so every test controls exactly what each of the
 * six sweep steps sees, deterministically and without touching the real
 * filesystem, network, or native model libraries.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const NODE_JOB_TYPES = ['face_detection', 'auto_tagging'] as const;

const mockDetectCapabilities = jest.fn();
const mockMissingRequirements = jest.fn();
const mockEvaluateStartupSelfTest = jest.fn();
jest.unstable_mockModule('../../src/node/capabilities.js', () => ({
  NODE_JOB_TYPES,
  isNodeJobType: (t: string) => (NODE_JOB_TYPES as readonly string[]).includes(t),
  detectCapabilities: mockDetectCapabilities,
  missingRequirements: mockMissingRequirements,
  evaluateStartupSelfTest: mockEvaluateStartupSelfTest,
}));

const mockRunOperationalSelfTests = jest.fn();
jest.unstable_mockModule('../../src/node/self-test.js', () => ({
  runOperationalSelfTests: mockRunOperationalSelfTests,
}));

const mockRunApiAccessChecks = jest.fn();
const mockCheckDaemonLiveness = jest.fn();
jest.unstable_mockModule('../../src/node/doctor-checks.js', () => ({
  runApiAccessChecks: mockRunApiAccessChecks,
  checkDaemonLiveness: mockCheckDaemonLiveness,
}));

const mockEnsureModels = jest.fn();
jest.unstable_mockModule('../../src/node/models.js', () => ({
  ensureModels: mockEnsureModels,
}));

const { runNodeDoctorSweep, initialDoctorSweepState, DOCTOR_STEP_ORDER } = await import(
  '../../src/tui/useNodeDoctorSweep.js'
);
type ApiClientLike = { getModelManifest: () => Promise<Array<{ name: string }>> };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK_ACCESS = {
  authOk: true,
  authDetail: 'token valid',
  nodeRegistrationOk: null as boolean | null,
  nodeRegistrationDetail: 'skipped',
  manifestOk: true,
  manifestDetail: 'reachable',
};

const OK_DAEMON = {
  running: false,
  stalePidfile: false,
  pidInfo: null,
  snapshot: null,
  detail: 'no worker-node daemon running on this machine',
};

function fakeApi(manifest: Array<{ name: string }> = [{ name: 'm1' }]): ApiClientLike {
  return { getModelManifest: jest.fn(async () => manifest) };
}

beforeEach(() => {
  mockDetectCapabilities.mockReset().mockResolvedValue({
    sharp: { available: true, detail: 'sharp' },
    human: { available: false, detail: 'human not installed' },
  });
  mockMissingRequirements.mockReset().mockReturnValue([]);
  mockEvaluateStartupSelfTest
    .mockReset()
    .mockReturnValue({ ok: true, blockingFailures: [], degraded: [] });
  mockRunOperationalSelfTests.mockReset().mockImplementation(async (caps: unknown) => caps);
  mockRunApiAccessChecks.mockReset().mockResolvedValue(OK_ACCESS);
  mockCheckDaemonLiveness.mockReset().mockResolvedValue(OK_DAEMON);
  mockEnsureModels.mockReset().mockResolvedValue({
    targetDir: '/tmp/models',
    downloaded: [],
    present: ['m1'],
    failed: [],
  });
});

// ---------------------------------------------------------------------------
// initialDoctorSweepState
// ---------------------------------------------------------------------------

describe('initialDoctorSweepState', () => {
  it('starts empty, not done, no error', () => {
    const state = initialDoctorSweepState();
    expect(state.currentStep).toBeNull();
    expect(state.completedSteps).toEqual([]);
    expect(state.apiAccess).toBeNull();
    expect(state.caps).toBeNull();
    expect(state.operationalCaps).toBeNull();
    expect(state.jobReadiness).toBeNull();
    expect(state.models).toBeNull();
    expect(state.daemon).toBeNull();
    expect(state.done).toBe(false);
    expect(state.hasError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runNodeDoctorSweep — happy path', () => {
  it('runs all six steps in order and aggregates their results with hasError=false', async () => {
    const api = fakeApi();
    const result = await runNodeDoctorSweep(api as never, { nodeId: 'node-1', node: undefined });

    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
    expect(result.currentStep).toBeNull();
    expect(result.done).toBe(true);
    expect(result.hasError).toBe(false);

    expect(result.apiAccess).toEqual(OK_ACCESS);
    expect(result.caps).toEqual({
      sharp: { available: true, detail: 'sharp' },
      human: { available: false, detail: 'human not installed' },
    });
    expect(result.operationalCaps).toEqual(result.caps);
    expect(result.jobReadiness).toEqual([
      { type: 'face_detection', ready: true, missing: [] },
      { type: 'auto_tagging', ready: true, missing: [] },
    ]);
    expect(result.models).toEqual({
      manifestCount: 1,
      downloaded: [],
      present: ['m1'],
      failed: [],
      targetDir: '/tmp/models',
      error: null,
    });
    expect(result.daemon).toEqual(OK_DAEMON);
  });

  it('reports incremental progress: currentStep set while a step runs, then folded into completedSteps', async () => {
    const seen: Array<{ currentStep: string | null; completedSteps: string[] }> = [];
    await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined }, (s) => {
      seen.push({ currentStep: s.currentStep, completedSteps: [...s.completedSteps] });
    });

    // First progress event enters step 1.
    expect(seen[0].currentStep).toBe('apiAccess');
    // At some point apiAccess finishes (currentStep cleared, folded into completedSteps)
    // before capabilities starts.
    const apiAccessDoneIdx = seen.findIndex((s) => s.completedSteps.includes('apiAccess'));
    const capsStartIdx = seen.findIndex((s) => s.currentStep === 'capabilities');
    expect(apiAccessDoneIdx).toBeGreaterThan(-1);
    expect(capsStartIdx).toBeGreaterThan(apiAccessDoneIdx);
    // Final event has every step completed, in the canonical order.
    expect(seen[seen.length - 1].completedSteps).toEqual(DOCTOR_STEP_ORDER);
    expect(seen[seen.length - 1].currentStep).toBeNull();
  });

  it('falls back to auto-detected supported types when no eligibleTypes are configured', async () => {
    mockMissingRequirements.mockImplementation((t: string) => (t === 'auto_tagging' ? ['sharp'] : []));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    // auto_tagging is excluded from the auto-detected set (not fully supported);
    // only face_detection is both eligible and ready.
    expect(result.jobReadiness).toEqual([{ type: 'face_detection', ready: true, missing: [] }]);
    expect(result.hasError).toBe(false);
  });

  it('uses the configured eligibleTypes list (filtered to known types) instead of auto-detecting', async () => {
    mockMissingRequirements.mockImplementation((t: string) => (t === 'face_detection' ? ['human'] : []));

    const result = await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: undefined,
      node: { eligibleTypes: ['face_detection', 'not_a_real_type'] },
    });

    expect(result.jobReadiness).toEqual([{ type: 'face_detection', ready: false, missing: ['human'] }]);
    expect(result.hasError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasError aggregation
// ---------------------------------------------------------------------------

describe('runNodeDoctorSweep — hasError aggregation', () => {
  it('sets hasError when auth fails, but still completes every step', async () => {
    mockRunApiAccessChecks.mockResolvedValue({
      authOk: false,
      authDetail: 'invalid token',
      nodeRegistrationOk: null,
      nodeRegistrationDetail: 'skipped',
      manifestOk: false,
      manifestDetail: 'unreachable',
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.hasError).toBe(true);
    expect(result.done).toBe(true);
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('does NOT set hasError from node-registration or manifest problems alone (warnings only)', async () => {
    mockRunApiAccessChecks.mockResolvedValue({
      authOk: true,
      authDetail: 'token valid',
      nodeRegistrationOk: false,
      nodeRegistrationDetail: 'not found',
      manifestOk: false,
      manifestDetail: 'unreachable',
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: 'gone', node: undefined });
    expect(result.hasError).toBe(false);
  });

  it('sets hasError when a model fails to download/verify', async () => {
    mockEnsureModels.mockResolvedValue({
      targetDir: '/tmp/models',
      downloaded: [],
      present: [],
      failed: [{ name: 'm1', error: 'checksum mismatch' }],
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });
    expect(result.hasError).toBe(true);
    expect(result.models?.failed).toEqual([{ name: 'm1', error: 'checksum mismatch' }]);
  });

  it('does NOT set hasError when the model manifest fetch itself throws (warning only)', async () => {
    const api = { getModelManifest: jest.fn(async () => { throw new Error('manifest down'); }) };

    const result = await runNodeDoctorSweep(api as never, { nodeId: undefined, node: undefined });
    expect(result.hasError).toBe(false);
    expect(result.models?.error).toBe('manifest down');
  });

  it('never sets hasError from daemon liveness (informational only)', async () => {
    mockCheckDaemonLiveness.mockResolvedValue({
      running: false,
      stalePidfile: true,
      pidInfo: { pid: 999_999_999, startedAt: new Date().toISOString(), socketPath: '/tmp/x.sock' },
      snapshot: null,
      detail: 'stale pidfile found',
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });
    expect(result.hasError).toBe(false);
    expect(result.daemon?.stalePidfile).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CompreFace config threading (faceProvider / comprefaceUrl)
// ---------------------------------------------------------------------------

describe('runNodeDoctorSweep — threads faceProvider/comprefaceUrl from config', () => {
  it('passes cfg.node.comprefaceUrl to detectCapabilities and runOperationalSelfTests when configured', async () => {
    await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: 'node-1',
      node: { comprefaceUrl: 'http://sidecar.local:9000' },
    });

    expect(mockDetectCapabilities).toHaveBeenCalledWith({ comprefaceUrl: 'http://sidecar.local:9000' });
    expect(mockRunOperationalSelfTests).toHaveBeenCalledWith(
      expect.anything(),
      { comprefaceUrl: 'http://sidecar.local:9000' },
    );
  });

  it('passes comprefaceUrl: undefined through when the node has no comprefaceUrl configured', async () => {
    await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(mockDetectCapabilities).toHaveBeenCalledWith({ comprefaceUrl: undefined });
    expect(mockRunOperationalSelfTests).toHaveBeenCalledWith(expect.anything(), { comprefaceUrl: undefined });
  });

  it("calls missingRequirements with faceProvider='compreface' for every job-readiness row when configured", async () => {
    mockMissingRequirements.mockReset().mockReturnValue([]);

    await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: undefined,
      node: { faceProvider: 'compreface', eligibleTypes: ['face_detection', 'auto_tagging'] },
    });

    expect(mockMissingRequirements).toHaveBeenCalledWith('face_detection', expect.anything(), 'compreface');
    expect(mockMissingRequirements).toHaveBeenCalledWith('auto_tagging', expect.anything(), 'compreface');
  });

  it("defaults to faceProvider='human' when the node config omits it", async () => {
    mockMissingRequirements.mockReset().mockReturnValue([]);

    await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: undefined,
      node: { eligibleTypes: ['face_detection'] },
    });

    expect(mockMissingRequirements).toHaveBeenCalledWith('face_detection', expect.anything(), 'human');
  });

  it("uses faceProvider='human' for the auto-detected (unconfigured eligibleTypes) job-readiness path too", async () => {
    mockMissingRequirements.mockReset().mockReturnValue([]);

    await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    for (const t of NODE_JOB_TYPES) {
      expect(mockMissingRequirements).toHaveBeenCalledWith(t, expect.anything(), 'human');
    }
  });
});

// ---------------------------------------------------------------------------
// Startup gate step (issue #148)
// ---------------------------------------------------------------------------

describe('runNodeDoctorSweep — startup gate', () => {
  it('evaluates the gate against the operational snapshot + resolved eligibleTypes/faceProvider and stores the verdict', async () => {
    const evaluation = { ok: true, blockingFailures: [], degraded: [] };
    mockEvaluateStartupSelfTest.mockReturnValue(evaluation);

    const result = await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: undefined,
      node: { faceProvider: 'compreface', eligibleTypes: ['face_detection'] },
    });

    expect(mockEvaluateStartupSelfTest).toHaveBeenCalledWith(
      result.caps,
      result.operationalCaps,
      ['face_detection'],
      'compreface',
    );
    expect(result.startupGate).toEqual(evaluation);
    expect(result.completedSteps).toContain('startupGate');
    expect(result.hasError).toBe(false);
  });

  it('sets hasError when the gate reports a blocking failure, even if job readiness passed', async () => {
    // Job readiness sees no missing requirements (default mock), but the gate
    // independently reports a required capability that failed its self-test.
    mockEvaluateStartupSelfTest.mockReturnValue({
      ok: false,
      blockingFailures: [{ capability: 'sharp', jobType: 'face_detection', detail: 'decode failed' }],
      degraded: [],
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, {
      nodeId: undefined,
      node: { eligibleTypes: ['face_detection'] },
    });

    expect(result.hasError).toBe(true);
    expect(result.startupGate?.blockingFailures).toHaveLength(1);
    expect(result.done).toBe(true);
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('does NOT set hasError for a degrade-only gate verdict', async () => {
    mockEvaluateStartupSelfTest.mockReturnValue({
      ok: true,
      blockingFailures: [],
      degraded: [{ capability: 'tesseract', detail: 'OCR data missing' }],
    });

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.hasError).toBe(false);
    expect(result.startupGate?.degraded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Never-throws error isolation
// ---------------------------------------------------------------------------

describe('runNodeDoctorSweep — never throws, degrades per step', () => {
  it('degrades gracefully when runApiAccessChecks rejects, and still completes the remaining steps', async () => {
    mockRunApiAccessChecks.mockRejectedValue(new Error('network unreachable'));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.done).toBe(true);
    expect(result.hasError).toBe(true);
    expect(result.apiAccess?.authOk).toBe(false);
    expect(result.apiAccess?.authDetail).toMatch(/network unreachable/);
    // The sweep continued past the failure — every later step still ran.
    expect(result.caps).not.toBeNull();
    expect(result.operationalCaps).not.toBeNull();
    expect(result.jobReadiness).not.toBeNull();
    expect(result.models).not.toBeNull();
    expect(result.daemon).not.toBeNull();
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('degrades gracefully when detectCapabilities rejects', async () => {
    mockDetectCapabilities.mockRejectedValue(new Error('probe crashed'));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.done).toBe(true);
    expect(result.caps).toBeTruthy();
    expect(result.caps?.['_error']?.available).toBe(false);
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('degrades gracefully when runOperationalSelfTests rejects', async () => {
    mockRunOperationalSelfTests.mockRejectedValue(new Error('self-test harness crashed'));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.done).toBe(true);
    // Falls back to the presence-only caps snapshot when the self-test step itself throws.
    expect(result.operationalCaps).toEqual(
      expect.objectContaining({ sharp: { available: true, detail: 'sharp' } }),
    );
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('degrades gracefully when checkDaemonLiveness rejects', async () => {
    mockCheckDaemonLiveness.mockRejectedValue(new Error('ipc probe crashed'));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.done).toBe(true);
    expect(result.daemon?.running).toBe(false);
    expect(result.daemon?.detail).toMatch(/ipc probe crashed/);
    expect(result.hasError).toBe(false);
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });

  it('degrades gracefully when ensureModels rejects', async () => {
    mockEnsureModels.mockRejectedValue(new Error('download failed mid-stream'));

    const result = await runNodeDoctorSweep(fakeApi() as never, { nodeId: undefined, node: undefined });

    expect(result.done).toBe(true);
    expect(result.models?.error).toMatch(/download failed mid-stream/);
    expect(result.hasError).toBe(false);
    expect(result.completedSteps).toEqual(DOCTOR_STEP_ORDER);
  });
});
