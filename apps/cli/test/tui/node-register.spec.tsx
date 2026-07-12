/**
 * test/tui/node-register.spec.tsx
 *
 * Tests for tui/NodeRegister.tsx — the "Worker Node — Register" Ink wizard.
 * Focus of this file: the face-detection provider (human/compreface) toggle
 * field added alongside name/concurrency/eligible-types, and its two ripple
 * effects —
 *
 *   1. selecting 'compreface' reveals a CompreFace base-URL text field
 *      prefilled with DEFAULT_COMPREFACE_URL;
 *   2. the auto-detected default eligible-types selection re-evaluates
 *      against whichever provider is currently selected (missingRequirements
 *      is threaded a 3rd `faceProvider` argument).
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
    human: { available: true, detail: '@vladmandic/human' },
  });
  // Default mock: face_detection is ready under 'human' but NOT under
  // 'compreface' (simulates the sidecar not being reachable/configured yet);
  // auto_tagging is always ready regardless of provider. This gives every
  // test a concrete, provider-dependent difference to assert against.
  mockMissingRequirements.mockReset().mockImplementation((t: string, _caps: unknown, faceProvider = 'human') => {
    if (t === 'face_detection' && faceProvider === 'compreface') return ['compreface'];
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
  it('defaults to the human provider and does not show the CompreFace URL field', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Face provider');
    expect(plain).toContain('[human]');
    expect(plain).not.toContain('CompreFace URL');
  });

  it('auto-detects both job types as eligible under the default human provider', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('face_detection, auto_tagging');
  });

  it('toggling to compreface with [space] reveals the CompreFace URL field prefilled with the default', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Tab twice: name -> concurrency -> faceProvider
    stdin.write('\t');
    await flushAsync();
    stdin.write('\t');
    await flushAsync();

    // Toggle the highlighted faceProvider field to 'compreface'.
    stdin.write(' ');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[compreface]');
    expect(plain).toContain('CompreFace URL');
    expect(plain).toContain(DEFAULT_COMPREFACE_URL);
  });

  it('re-evaluates the auto-detected default types against the newly-selected provider', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Before toggling: both types are the auto-detected default.
    expect(stripAnsi(lastFrame()!)).toContain('face_detection, auto_tagging');

    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> faceProvider
    await flushAsync();
    stdin.write(' '); // toggle -> compreface
    await flushAsync();

    // face_detection is no longer supported under compreface per the mock,
    // so the recomputed default should drop it, leaving only auto_tagging.
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toMatch(/Types\s+auto_tagging(?!\s*,)/);
    expect(plain).not.toContain('face_detection, auto_tagging');
  });

  it('does NOT overwrite a manually-edited Types field when the provider is toggled', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Navigate all the way to the Types field and hand-edit it.
    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> faceProvider
    await flushAsync();
    stdin.write('\t'); // -> types (still human, comprefaceUrl not in the tour)
    await flushAsync();
    stdin.write('x'); // hand-edit marker appended
    await flushAsync();

    // Now go back up to faceProvider and toggle it.
    stdin.write('\x1B[A'); // upArrow -> back to faceProvider
    await flushAsync();
    stdin.write(' '); // toggle -> compreface
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // The hand-edited value (with the trailing 'x') must survive the toggle.
    expect(plain).toContain('face_detection, auto_taggingx');
  });

  it('is editable: typing into the CompreFace URL field updates its value', async () => {
    const { lastFrame, stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> faceProvider
    await flushAsync();
    stdin.write(' '); // toggle -> compreface
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
    stdin.write('\t'); // -> faceProvider
    await flushAsync();
    stdin.write(' '); // toggle -> compreface
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

  it('persists faceProvider=human and no comprefaceUrl when the toggle is left at the default', async () => {
    const { stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    // Tab straight through to submission without touching the toggle.
    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> faceProvider
    await flushAsync();
    stdin.write('\r'); // Enter on faceProvider advances (no toggle) -> types
    await flushAsync();
    stdin.write('\r'); // submit
    await flushAsync(150);

    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveConfig.mock.calls[0][0] as CliConfig;
    expect(savedConfig.node?.faceProvider).toBe('human');
    expect(savedConfig.node?.comprefaceUrl).toBeUndefined();
  });
});
