/**
 * test/tui/node-doctor-render.spec.tsx
 *
 * Render tests for tui/NodeDoctor.tsx (the full-screen "Worker Node — Doctor"
 * screen). test/tui/node-doctor-sweep.spec.ts already covers the underlying
 * `runNodeDoctorSweep()` data/aggregation logic in isolation (no Ink); this
 * file instead drives the RENDERING logic — the collapse-to-one-line
 * behavior for the Capabilities/Job-readiness sections and the top-checklist
 * health icons — by mocking `useNodeDoctorSweep` itself so each test supplies
 * a fully-formed, deterministic `DoctorSweepState` fixture directly, mirroring
 * the "mock the underlying data" approach suggested for this component (as
 * opposed to driving the real sweep end-to-end, which the sibling
 * node-doctor-sweep.spec.ts already exercises).
 *
 * `DOCTOR_STEP_ORDER`/`DOCTOR_STEP_LABELS` are re-exported verbatim from the
 * mock factory (copied constants, not re-imported) since jest.unstable_mockModule
 * factories cannot reference outer-scope real imports before they run.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import type { CliConfig } from '../../src/config.js';
import type {
  DoctorSweepState,
  DoctorStepKey,
  ApiAccessCheckResult,
} from '../../src/tui/useNodeDoctorSweep.js';
import type { CapabilityStatus } from '../../src/node/capabilities.js';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

const DOCTOR_STEP_ORDER: DoctorStepKey[] = [
  'apiAccess',
  'capabilities',
  'selfTest',
  'jobReadiness',
  'startupGate',
  'models',
  'daemon',
];

const DOCTOR_STEP_LABELS: Record<DoctorStepKey, string> = {
  apiAccess: 'API Access',
  capabilities: 'Capabilities (installed)',
  selfTest: 'Operational self-tests',
  jobReadiness: 'Job-type readiness',
  startupGate: 'Startup gate',
  models: 'Models',
  daemon: 'Daemon',
};

const mockUseNodeDoctorSweep = jest.fn();

jest.unstable_mockModule('../../src/tui/useNodeDoctorSweep.js', () => ({
  DOCTOR_STEP_ORDER,
  DOCTOR_STEP_LABELS,
  useNodeDoctorSweep: mockUseNodeDoctorSweep,
}));

const { NodeDoctor } = await import('../../src/tui/NodeDoctor.js');
const { WORKER_NODE_SETUP_GUIDE_URL } = await import('../../src/node/doctor-summary.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

const config: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
  nodeId: 'node-123',
};

const OK_ACCESS: ApiAccessCheckResult = {
  authOk: true,
  authDetail: 'token valid',
  nodeRegistrationOk: true,
  nodeRegistrationDetail: 'node record found server-side',
  manifestOk: true,
  manifestDetail: 'reachable — 2 model file(s) listed',
};

function cap(available: boolean, detail?: string): CapabilityStatus {
  return { available, detail };
}

/** A fully-healthy sweep state: every step ok, nothing to collapse-expand. */
function healthyState(): DoctorSweepState {
  return {
    currentStep: null,
    completedSteps: [...DOCTOR_STEP_ORDER],
    apiAccess: OK_ACCESS,
    caps: {
      sharp: cap(true, 'sharp'),
      human: cap(true, '@vladmandic/human'),
      ffmpeg: cap(true, 'ffmpeg on PATH'),
    },
    operationalCaps: {
      sharp: cap(true, 'sharp'),
      human: cap(true, '@vladmandic/human'),
      ffmpeg: cap(true, 'ffmpeg on PATH'),
    },
    jobReadiness: [
      { type: 'face_detection', ready: true, missing: [] },
      { type: 'auto_tagging', ready: true, missing: [] },
    ],
    startupGate: { ok: true, blockingFailures: [], degraded: [] },
    models: {
      manifestCount: 2,
      downloaded: [],
      present: ['a', 'b'],
      failed: [],
      targetDir: '/tmp/models',
      error: null,
    },
    daemon: {
      running: false,
      stalePidfile: false,
      pidInfo: null,
      snapshot: null,
      detail: 'no worker-node daemon running on this machine',
    },
    done: true,
    hasError: false,
  };
}

afterEach(() => {
  cleanup();
  mockUseNodeDoctorSweep.mockReset();
});

function renderDoctor(state: DoctorSweepState): { plain: string; unmount: () => void } {
  mockUseNodeDoctorSweep.mockReturnValue({ state, running: false, run: jest.fn() });
  const { lastFrame, unmount } = render(<NodeDoctor config={config} onBack={() => {}} />);
  return { plain: stripAnsi(lastFrame()!), unmount };
}

// ---------------------------------------------------------------------------
// All-healthy: everything collapses to one-liners
// ---------------------------------------------------------------------------

describe('NodeDoctor — all-healthy state', () => {
  it('collapses Capabilities to one line, not the full per-row table', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    expect(plain).toContain('✔ All 3 capabilities operational.');
    // The per-row table (with its column headers and individual keys) must
    // NOT be rendered when nothing needs attention. 'Installed'/'Detail' are
    // unique to the table header (unlike 'Operational', which also appears
    // in the top checklist's "Operational self-tests" label).
    expect(plain).not.toContain('Installed');
    expect(plain).not.toContain('Detail');
    unmount();
  });

  it('collapses Job-type readiness to one line, not the per-row list', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    expect(plain).toContain('✔ All 2 job type(s) ready.');
    expect(plain).not.toContain('face_detection');
    expect(plain).not.toContain('auto_tagging');
    unmount();
  });

  it('collapses API Access to one line', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    expect(plain).toContain('✔ API access ok — token valid');
    unmount();
  });

  it('shows the setup guide URL once the sweep is done', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    expect(plain).toContain(WORKER_NODE_SETUP_GUIDE_URL);
    unmount();
  });

  it('shows a plain green check for every top-checklist step', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    for (const label of Object.values(DOCTOR_STEP_LABELS)) {
      expect(plain).toContain(`✔ ${label}`);
    }
    unmount();
  });
});

// ---------------------------------------------------------------------------
// One capability issue: only the offending row is shown
// ---------------------------------------------------------------------------

describe('NodeDoctor — one capability issue', () => {
  it('renders the summary count plus only the tesseract row', () => {
    const state = healthyState();
    state.caps = { ...state.caps!, tesseract: cap(true, 'tesseract.js') };
    state.operationalCaps = {
      ...state.operationalCaps!,
      tesseract: cap(false, 'tesseract language data not present'),
    };

    const { plain, unmount } = renderDoctor(state);
    expect(plain).toContain('3/4 capabilities operational — showing 1 needing attention:');
    expect(plain).toContain('tesseract');
    expect(plain).toContain('tesseract language data not present');
    // Healthy rows must not appear in the (now issue-only) table.
    expect(plain).not.toContain('sharp');
    expect(plain).not.toContain('human');
    expect(plain).not.toContain('ffmpeg');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// One not-ready job type: only that row is shown
// ---------------------------------------------------------------------------

describe('NodeDoctor — one not-ready job type', () => {
  it('renders the summary count plus only the not-ready row', () => {
    const state = healthyState();
    state.jobReadiness = [
      { type: 'face_detection', ready: true, missing: [] },
      { type: 'auto_tagging', ready: false, missing: ['sharp'] },
    ];

    const { plain, unmount } = renderDoctor(state);
    expect(plain).toContain('1/2 ready');
    expect(plain).toContain('✖ auto_tagging');
    expect(plain).toContain('missing sharp');
    expect(plain).not.toContain('face_detection');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Startup gate section (issue #148)
// ---------------------------------------------------------------------------

describe('NodeDoctor — startup gate', () => {
  it('collapses to a single PASS line when the gate is ok', () => {
    const { plain, unmount } = renderDoctor(healthyState());
    expect(plain).toContain('✔ Startup gate: PASS — all required capabilities operational.');
    unmount();
  });

  it('renders the BLOCKED verdict and each required capability that failed', () => {
    const state = healthyState();
    state.startupGate = {
      ok: false,
      blockingFailures: [{ capability: 'human', jobType: 'face_detection', detail: 'model missing' }],
      degraded: [{ capability: 'tesseract', detail: 'OCR data not present' }],
    };
    state.hasError = true;

    const { plain, unmount } = renderDoctor(state);
    expect(plain).toContain('✖ Startup gate: BLOCKED');
    expect(plain).toContain('human (required by face_detection)');
    expect(plain).toContain('tesseract — degraded but non-blocking');
    // Top-checklist row reflects the error, not a plain check.
    expect(plain).toContain('✖ Startup gate');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Top checklist reflects real health, not just "step finished"
// ---------------------------------------------------------------------------

describe('NodeDoctor — top checklist reflects actual health', () => {
  it('shows a warning icon (not a plain check) for a step that found a problem', () => {
    const state = healthyState();
    state.daemon = {
      running: false,
      stalePidfile: true,
      pidInfo: { pid: 999_999, startedAt: new Date().toISOString(), socketPath: '/tmp/x.sock' },
      snapshot: null,
      detail: 'stale pidfile found (pid 999999 is not running)',
    };
    // Daemon liveness never sets hasError (informational only) — confirm the
    // overall verdict stays green even though this one step is flagged.
    state.hasError = false;

    const { plain, unmount } = renderDoctor(state);
    expect(plain).toContain('⚠ Daemon');
    expect(plain).not.toContain('✔ Daemon');
    expect(plain).toContain('✔ Doctor: all checks passed.');
    unmount();
  });

  it('shows an error icon for a step with a real error (job-type readiness)', () => {
    const state = healthyState();
    state.jobReadiness = [{ type: 'face_detection', ready: false, missing: ['human'] }];
    state.hasError = true;

    const { plain, unmount } = renderDoctor(state);
    expect(plain).toContain('✖ Job-type readiness');
    unmount();
  });
});
