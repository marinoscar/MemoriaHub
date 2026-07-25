/**
 * test/tui/node-register.spec.tsx
 *
 * Tests for tui/NodeRegister.tsx — the "Worker Node — Register" Ink wizard.
 * Focus of this file: the CompreFace base-URL field (CompreFace is the node's
 * ONLY face provider since issue #113, so the old human/compreface toggle is
 * gone), the wizard's field tour, and what is persisted locally vs. sent to
 * the server on submit.
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
  // Default mock: everything is ready.
  mockMissingRequirements.mockReset().mockImplementation(() => []);
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

describe('NodeRegister — CompreFace URL field', () => {
  it('always shows the CompreFace URL field, prefilled with the default, and no provider selector', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('CompreFace URL');
    expect(plain).toContain(DEFAULT_COMPREFACE_URL);
    expect(plain).not.toContain('Face provider');
    expect(plain).not.toContain('[human]');
  });

  it('prefills the CompreFace URL from an existing node config', async () => {
    const { lastFrame } = render(
      <NodeRegister
        config={
          {
            ...BASE_CONFIG,
            node: { comprefaceUrl: 'http://sidecar.local:9000' },
          } as never
        }
        onBack={() => {}}
      />,
    );
    await flushAsync(100);

    expect(stripAnsi(lastFrame()!)).toContain('http://sidecar.local:9000');
  });

  it('threads the configured comprefaceUrl into the capability probe', async () => {
    render(
      <NodeRegister
        config={
          {
            ...BASE_CONFIG,
            node: { comprefaceUrl: 'http://sidecar.local:9000' },
          } as never
        }
        onBack={() => {}}
      />,
    );
    await flushAsync(100);

    expect(mockDetectCapabilities).toHaveBeenCalledWith({
      comprefaceUrl: 'http://sidecar.local:9000',
    });
  });

  it('auto-detects the eligible job types from capabilities', async () => {
    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    expect(stripAnsi(lastFrame()!)).toContain('face_detection, auto_tagging');
  });

  it('drops a job type whose requirements are unmet from the auto-detected default', async () => {
    mockMissingRequirements.mockImplementation((t: string) =>
      t === 'face_detection' ? ['compreface'] : [],
    );

    const { lastFrame } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toMatch(/Types\s+auto_tagging(?!\s*,)/);
    expect(plain).not.toContain('face_detection, auto_tagging');
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

  it('persists the edited comprefaceUrl on submit, without sending it to the server', async () => {
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

    // Server payload must NOT include comprefaceUrl.
    expect(mockRegisterNode).toHaveBeenCalledTimes(1);
    const payload = mockRegisterNode.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('faceProvider');
    expect(payload).not.toHaveProperty('comprefaceUrl');

    // Local config MUST persist it.
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveConfig.mock.calls[0][0] as CliConfig;
    expect(savedConfig.node).not.toHaveProperty('faceProvider');
    expect(savedConfig.node?.comprefaceUrl).toBe('http://sidecar.local:9000');
  });

  it('persists the default comprefaceUrl when the field is left untouched', async () => {
    const { stdin } = render(
      <NodeRegister config={BASE_CONFIG as never} onBack={() => {}} />,
    );
    await flushAsync(100);

    stdin.write('\t'); // -> concurrency
    await flushAsync();
    stdin.write('\t'); // -> comprefaceUrl
    await flushAsync();
    stdin.write('\r'); // submit comprefaceUrl -> types
    await flushAsync();
    stdin.write('\r'); // submit
    await flushAsync(150);

    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockSaveConfig.mock.calls[0][0] as CliConfig;
    expect(savedConfig.node?.comprefaceUrl).toBe(DEFAULT_COMPREFACE_URL);
  });
});
