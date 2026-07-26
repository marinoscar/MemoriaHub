/**
 * test/tui/node-register.spec.tsx
 *
 * Tests for tui/NodeRegister.tsx — the "Worker Node — Register" Ink wizard.
 *
 * NOTE (issue #113): Human and AWS Rekognition were removed — CompreFace is
 * the only supported face-detection provider. There is no longer a
 * faceProvider toggle field in the wizard: "Face provider" is now a static,
 * non-focusable display line ("compreface (fixed — the only supported
 * provider)"), and the "CompreFace URL" field is now ALWAYS part of the tab
 * order (FIELD_ORDER = ['name', 'concurrency', 'comprefaceUrl', 'types']) —
 * previously it only appeared after toggling the provider to 'compreface'.
 * The auto-detected default eligible-types selection is still computed from
 * `missingRequirements(type, caps, 'compreface')` (the fixed provider), so
 * whether face_detection appears in the default set still depends on the
 * capability snapshot — just without a UI toggle driving it.
 *
 * All collaborators (api.js, config.js, node/capabilities.js) are mocked via
 * jest.unstable_mockModule so the test controls exactly what capability
 * detection and job-type readiness report, deterministically.
 */

import { jest } from '@jest/globals';
import React from 'react';
import type { CliConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const NODE_JOB_TYPES = ['face_detection', 'auto_tagging'] as const;
const DEFAULT_COMPREFACE_URL = 'http://localhost:3000';

const mockDetectCapabilities = jest.fn();
const mockMissingRequirements = jest.fn();

jest.unstable_mockModule('../../src/node/capabilities.js', () => ({
  DEFAULT_COMPREFACE_URL,
  NODE_JOB_TYPES,
  isNodeJobType: (t: string) => (NODE_JOB_TYPES as readonly string[]).includes(t),
  detectCapabilities: mockDetectCapabilities,
  missingRequirements: mockMissingRequirements,
}));

const mockRegisterNode = jest.fn();

class MockApiClient {
  registerNode(...args: unknown[]) {
    return mockRegisterNode(...args);
  }
}

class MockApiError extends Error {
  constructor(public status: number, public serverMessage: string) {
    super(`API error ${status}: ${serverMessage}`);
  }
}

jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: MockApiClient,
  ApiError: MockApiError,
}));

const mockSaveConfig = jest.fn();
jest.unstable_mockModule('../../src/config.js', () => ({
  saveConfig: mockSaveConfig,
}));

// ---------------------------------------------------------------------------
// Dynamic imports AFTER all unstable_mockModule declarations
// ---------------------------------------------------------------------------

const { render, cleanup } = await import('ink-testing-library');
const { NodeRegister } = await import('../../src/tui/NodeRegister.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const BASE_CONFIG = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
};

beforeEach(() => {
  mockDetectCapabilities.mockReset().mockResolvedValue({
    sharp: { available: true, detail: 'sharp' },
    compreface: { available: true, detail: 'compreface-core reachable' },
  });
  // Default mock: both face_detection (needs compreface) and auto_tagging
  // (no requirements) are ready — compreface is reachable per the snapshot
  // above. faceProvider is always 'compreface' now; the 3rd arg is accepted
  // for signature parity but not branched on.
  mockMissingRequirements.mockReset().mockImplementation((t: string, caps: Record<string, { available: boolean }>) => {
    if (t === 'face_detection' && !caps['compreface']?.available) return ['compreface'];
    return [];
  });
  mockRegisterNode.mockReset().mockResolvedValue({ nodeId: 'node-abc' });
  mockSaveConfig.mockReset();
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeRegister — face-detection provider field', () => {
  it('shows the Face provider row as a fixed compreface display, and always shows the CompreFace URL field', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Face provider');
    expect(plain).toContain('compreface (fixed — the only supported provider)');
    expect(plain).toContain('CompreFace URL');
    expect(plain).toContain(DEFAULT_COMPREFACE_URL);
  });

  it('auto-detects both job types as eligible when compreface is reachable', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('face_detection, auto_tagging');
  });

  it('auto-detects only auto_tagging when compreface is not reachable', async () => {
    mockDetectCapabilities.mockReset().mockResolvedValue({
      sharp: { available: true, detail: 'sharp' },
      compreface: { available: false, detail: 'compreface-core not reachable' },
    });

    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toMatch(/Types\s+auto_tagging(?!\s*,)/);
    expect(plain).not.toContain('face_detection, auto_tagging');
  });

  it('the static Face provider row does not react to [space] (not a focusable field)', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Tab twice: name -> concurrency -> comprefaceUrl (Face provider is not
    // in FIELD_ORDER at all, so it can never receive focus).
    stdin.write('\t');
    await flushAsync();
    stdin.write('\t');
    await flushAsync();
    stdin.write(' '); // no-op on the comprefaceUrl TextInput other than typing a space
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('compreface (fixed — the only supported provider)');
  });

  it('does NOT lose a manually-edited Types field when navigating away and back', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Navigate all the way to the Types field and hand-edit it.
    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> comprefaceUrl
    await flushAsync();
    stdin.write('\t'); // -> types
    await flushAsync();
    stdin.write('x'); // hand-edit marker appended
    await flushAsync();

    // Navigate away and back.
    stdin.write('\x1B[A'); // upArrow -> back to comprefaceUrl
    await flushAsync();
    stdin.write('\x1B[B'); // downArrow -> forward to types again
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // The hand-edited value (with the trailing 'x') must survive navigation.
    expect(plain).toContain('face_detection, auto_taggingx');
  });

  it('is editable: typing into the CompreFace URL field updates its value', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> comprefaceUrl
    await flushAsync();

    // Clear the prefilled default, then type a custom URL.
    for (let i = 0; i < DEFAULT_COMPREFACE_URL.length; i++) {
      stdin.write('\x7f');
      await flushAsync(20);
    }
    stdin.write('http://sidecar.local:9000');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('http://sidecar.local:9000');
    expect(plain).not.toContain(DEFAULT_COMPREFACE_URL);
  });

  it('persists faceProvider=compreface and the edited comprefaceUrl on submit, without sending them to the server', async () => {
    const { stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> comprefaceUrl
    await flushAsync();

    for (let i = 0; i < DEFAULT_COMPREFACE_URL.length; i++) {
      stdin.write('\x7f');
      await flushAsync(20);
    }
    stdin.write('http://sidecar.local:9000');
    await flushAsync();
    stdin.write('\r'); // submit comprefaceUrl -> advances to types
    await flushAsync();
    stdin.write('\r'); // submit types -> registers
    await flushAsync(150);

    // Server payload must NOT include faceProvider/comprefaceUrl.
    expect(mockRegisterNode).toHaveBeenCalledTimes(1);
    const payload = mockRegisterNode.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('faceProvider');
    expect(payload).not.toHaveProperty('comprefaceUrl');

    // Local config MUST persist both fields.
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveConfig.mock.calls[0][0] as CliConfig;
    expect(savedConfig.node?.faceProvider).toBe('compreface');
    expect(savedConfig.node?.comprefaceUrl).toBe('http://sidecar.local:9000');
  });

  it('persists faceProvider=compreface and the default comprefaceUrl when the field is left untouched', async () => {
    const { stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Tab straight through to submission without editing anything.
    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> comprefaceUrl
    await flushAsync();
    stdin.write('\r'); // submit comprefaceUrl (unedited default) -> advances to types
    await flushAsync();
    stdin.write('\r'); // submit
    await flushAsync(150);

    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveConfig.mock.calls[0][0] as CliConfig;
    expect(savedConfig.node?.faceProvider).toBe('compreface');
    expect(savedConfig.node?.comprefaceUrl).toBe(DEFAULT_COMPREFACE_URL);
  });
});
