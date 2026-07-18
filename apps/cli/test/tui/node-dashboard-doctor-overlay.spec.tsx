/**
 * test/tui/node-dashboard-doctor-overlay.spec.tsx
 *
 * Render tests for the `[r]` doctor overlay inside tui/NodeDashboard.tsx.
 * Unlike tui/NodeDoctor.tsx (the full-screen doctor, covered by
 * node-doctor-render.spec.tsx), this overlay drives the REAL
 * `runNodeDoctorSweep()` (NodeDashboard calls it directly rather than
 * mounting <NodeDoctor>, per that component's own header comment), so this
 * suite mocks the sweep's four collaborator modules
 * (node/capabilities.ts, node/self-test.ts, node/doctor-checks.ts,
 * node/models.ts) the same way test/tui/node-doctor-sweep.spec.ts does, plus
 * node/ipc-client.ts (forced to report no daemon running, so the dashboard
 * takes the cheap 'embedded' path without ever starting a real engine) and
 * ../api.js (a stub ApiClient whose only method the sweep needs —
 * getModelManifest — is exercised).
 *
 * No real network, filesystem daemon, or native model library is touched.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import type { CliConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
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
  // Unused by this suite (no engine is ever started), but NodeDashboard.tsx →
  // NodeEngine imports these at module scope, so the mock factory must provide
  // them or the ESM linker rejects the whole graph before any test runs.
  ComputeDispatcher: class {
    compute = jest.fn();
  },
  mergeOperationalCapabilities: (presence: unknown) => presence,
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

jest.unstable_mockModule('../../src/node/ipc-client.js', () => ({
  isDaemonRunning: jest.fn(async () => false),
  connectToDaemon: jest.fn(),
}));

let modelManifest: Array<{ name: string }> = [{ name: 'm1' }];
jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: class {
    constructor(_opts: unknown) {}
    async getModelManifest() {
      return modelManifest;
    }
  },
}));

const { NodeDashboard } = await import('../../src/tui/NodeDashboard.js');

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const config: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
  nodeId: 'node-123',
  node: {
    name: 'test-node',
    concurrency: 1,
    eligibleTypes: ['face_detection', 'auto_tagging'],
    pollIntervalMs: 5000,
  },
};

const OK_ACCESS = {
  authOk: true,
  authDetail: 'token valid',
  nodeRegistrationOk: true,
  nodeRegistrationDetail: 'node record found server-side',
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

beforeEach(() => {
  modelManifest = [{ name: 'm1' }];
  mockDetectCapabilities.mockReset().mockResolvedValue({
    sharp: { available: true, detail: 'sharp' },
    human: { available: true, detail: '@vladmandic/human' },
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

afterEach(() => {
  cleanup();
});

async function openDoctorOverlay(): Promise<{ plain: string; unmount: () => void }> {
  const { lastFrame, stdin, unmount } = render(<NodeDashboard config={config} onBack={() => {}} />);
  await flushAsync(50); // let initSource() resolve to 'embedded' mode
  stdin.write('r');
  await flushAsync(200); // let the full 6-step sweep (all mocked, but still async) finish
  return { plain: stripAnsi(lastFrame()!), unmount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeDashboard doctor overlay ([r]) — all healthy', () => {
  it('collapses capabilities and job readiness to one-liners, and shows the setup guide', async () => {
    const { plain, unmount } = await openDoctorOverlay();

    expect(plain).toContain('Worker Node — Doctor');
    expect(plain).toContain('✔ All 2 capabilities operational.');
    expect(plain).toContain('✔ All 2 job type(s) ready.');
    expect(plain).toContain('✔ Startup gate: PASS — all required capabilities operational.');
    expect(plain).toContain('✔ Doctor: all checks passed.');
    expect(plain).toContain('https://github.com/marinoscar/MemoriaHub/blob/main/docs/worker-node-setup.md');
    // The per-row table must not render when nothing needs attention.
    expect(plain).not.toContain('Detail');
    unmount();
  });
});

describe('NodeDashboard doctor overlay ([r]) — one capability issue', () => {
  it('shows the summary count plus only the offending row', async () => {
    mockDetectCapabilities.mockResolvedValue({
      sharp: { available: true, detail: 'sharp' },
      human: { available: true, detail: '@vladmandic/human' },
    });
    // Self-test degrades "human" to not-operational; "sharp" stays fine.
    mockRunOperationalSelfTests.mockImplementation(async (caps: unknown) => ({
      ...(caps as Record<string, unknown>),
      human: { available: false, detail: 'human model not downloaded yet' },
    }));

    const { plain, unmount } = await openDoctorOverlay();

    expect(plain).toContain('1/2 capabilities operational — showing 1 needing attention:');
    expect(plain).toContain('human');
    expect(plain).toContain('human model not downloaded yet');
    expect(plain).not.toContain('sharp');
    unmount();
  });
});

describe('NodeDashboard doctor overlay ([r]) — startup gate blocked', () => {
  it('renders the BLOCKED verdict and lists the required capability that failed', async () => {
    mockEvaluateStartupSelfTest.mockReturnValue({
      ok: false,
      blockingFailures: [{ capability: 'human', jobType: 'face_detection', detail: 'model missing' }],
      degraded: [],
    });

    const { plain, unmount } = await openDoctorOverlay();

    expect(plain).toContain('✖ Startup gate: BLOCKED');
    expect(plain).toContain('human (required by face_detection)');
    expect(plain).toContain('✖ Doctor found problems.');
    unmount();
  });
});

describe('NodeDashboard doctor overlay ([r]) — one not-ready job type', () => {
  it('shows the summary count plus only the not-ready row', async () => {
    mockMissingRequirements.mockImplementation((t: string) => (t === 'auto_tagging' ? ['human'] : []));

    const { plain, unmount } = await openDoctorOverlay();

    expect(plain).toContain('1/2 ready');
    expect(plain).toContain('✖ auto_tagging');
    expect(plain).toContain('missing human');
    expect(plain).not.toContain('face_detection');
    unmount();
  });
});
