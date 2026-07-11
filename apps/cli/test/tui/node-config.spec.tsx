/**
 * test/tui/node-config.spec.tsx
 *
 * Tests for tui/NodeConfig.tsx — the "Worker Node — Configuration" post-
 * registration editor. Focus of this file: the face-detection provider
 * (human/compreface) menu row, which toggles in place with [space] or
 * [Enter] (no sub-screen, unlike the other fields), and the CompreFace
 * base-URL row that only appears — and is only editable — while the
 * provider is 'compreface'.
 *
 * node/ipc-client.js is mocked so `isDaemonRunning()` resolves false — no
 * daemon is running in these tests, so the concurrency-push-live path
 * (irrelevant to this file's focus) short-circuits immediately.
 */

import { jest } from '@jest/globals';
import React from 'react';
import type { CliConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const NODE_JOB_TYPES = ['face_detection', 'auto_tagging'] as const;
const DEFAULT_COMPREFACE_URL = 'http://localhost:3000';

jest.unstable_mockModule('../../src/node/capabilities.js', () => ({
  DEFAULT_COMPREFACE_URL,
  NODE_JOB_TYPES,
}));

const mockSaveConfig = jest.fn();
jest.unstable_mockModule('../../src/config.js', () => ({
  saveConfig: mockSaveConfig,
}));

jest.unstable_mockModule('../../src/node/ipc-client.js', () => ({
  isDaemonRunning: jest.fn(async () => false),
  connectToDaemon: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports AFTER all unstable_mockModule declarations
// ---------------------------------------------------------------------------

const { render, cleanup } = await import('ink-testing-library');
const { NodeConfig } = await import('../../src/tui/NodeConfig.js');

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

const BASE_CONFIG: CliConfig = {
  serverUrl: 'https://example.test',
  pat: 'pat_abc',
  nodeId: 'node-123',
  node: {
    name: 'my-node',
    concurrency: 2,
    eligibleTypes: [...NODE_JOB_TYPES],
    pollIntervalMs: 5000,
  },
};

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeConfig — face-detection provider field', () => {
  it('shows the Face provider row defaulted to human and no CompreFace URL row', () => {
    const { lastFrame } = render(
      <NodeConfig config={BASE_CONFIG} onBack={() => {}} />,
    );

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Face provider');
    expect(plain).toContain('human');
    expect(plain).not.toContain('CompreFace URL');
  });

  it('pre-fills the provider from an existing compreface config and shows the CompreFace URL row', () => {
    const config: CliConfig = {
      ...BASE_CONFIG,
      node: { ...BASE_CONFIG.node, faceProvider: 'compreface', comprefaceUrl: 'http://sidecar.local:9000' },
    };
    const { lastFrame } = render(<NodeConfig config={config} onBack={() => {}} />);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Face provider');
    expect(plain).toContain('compreface');
    expect(plain).toContain('CompreFace URL');
    expect(plain).toContain('http://sidecar.local:9000');
  });

  it('[space] toggles the highlighted Face provider row to compreface and reveals the URL row prefilled with the default', async () => {
    const { lastFrame, stdin } = render(
      <NodeConfig config={BASE_CONFIG} onBack={() => {}} />,
    );

    // Menu order: name(0), concurrency(1), poll(2), faceProvider(3).
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();

    stdin.write(' '); // toggle
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('compreface');
    expect(plain).toContain('CompreFace URL');
    expect(plain).toContain(DEFAULT_COMPREFACE_URL);
  });

  it('[space] toggle persists faceProvider=compreface with the default comprefaceUrl immediately', async () => {
    const { stdin } = render(<NodeConfig config={BASE_CONFIG} onBack={() => {}} />);

    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write(' ');
    await flushAsync();

    expect(mockSaveConfig).toHaveBeenCalled();
    const lastCall = mockSaveConfig.mock.calls[mockSaveConfig.mock.calls.length - 1][0] as CliConfig;
    expect(lastCall.node?.faceProvider).toBe('compreface');
    expect(lastCall.node?.comprefaceUrl).toBe(DEFAULT_COMPREFACE_URL);
  });

  it('pressing Enter on the Face provider row also toggles it (same effect as space)', async () => {
    const { lastFrame, stdin } = render(
      <NodeConfig config={BASE_CONFIG} onBack={() => {}} />,
    );

    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\r'); // Enter, via SelectInput's onSelect -> handleSelect('faceProvider')
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('compreface');
    expect(plain).toContain('CompreFace URL');
  });

  it('editing the CompreFace URL field persists the new value', async () => {
    const config: CliConfig = {
      ...BASE_CONFIG,
      node: { ...BASE_CONFIG.node, faceProvider: 'compreface', comprefaceUrl: DEFAULT_COMPREFACE_URL },
    };
    const { lastFrame, stdin } = render(<NodeConfig config={config} onBack={() => {}} />);

    // Menu order now: name(0), concurrency(1), poll(2), faceProvider(3), comprefaceUrl(4).
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\r'); // Enter -> edit-text for comprefaceUrl
    await flushAsync();

    // Clear the prefilled value, type a new one, submit.
    for (let i = 0; i < DEFAULT_COMPREFACE_URL.length; i++) {
      stdin.write('\x7f');
      await flushAsync(20);
    }
    stdin.write('http://new-sidecar.local:4000');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    expect(mockSaveConfig).toHaveBeenCalled();
    const lastCall = mockSaveConfig.mock.calls[mockSaveConfig.mock.calls.length - 1][0] as CliConfig;
    expect(lastCall.node?.comprefaceUrl).toBe('http://new-sidecar.local:4000');

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Saved CompreFace URL');
  });

  it('rejects an empty CompreFace URL without persisting', async () => {
    const config: CliConfig = {
      ...BASE_CONFIG,
      node: { ...BASE_CONFIG.node, faceProvider: 'compreface', comprefaceUrl: DEFAULT_COMPREFACE_URL },
    };
    const { lastFrame, stdin } = render(<NodeConfig config={config} onBack={() => {}} />);

    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\x1B[B');
    await flushAsync();
    stdin.write('\r'); // Enter -> edit-text for comprefaceUrl
    await flushAsync();

    for (let i = 0; i < DEFAULT_COMPREFACE_URL.length; i++) {
      stdin.write('\x7f');
      await flushAsync(20);
    }
    stdin.write('\r'); // submit empty
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('CompreFace URL is required');
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('toggling back to human removes the CompreFace URL row and persists comprefaceUrl=undefined', async () => {
    const config: CliConfig = {
      ...BASE_CONFIG,
      node: { ...BASE_CONFIG.node, faceProvider: 'compreface', comprefaceUrl: 'http://sidecar.local:9000' },
    };
    const { lastFrame, stdin } = render(<NodeConfig config={config} onBack={() => {}} />);

    stdin.write('\x1B[B'); // -> concurrency
    await flushAsync();
    stdin.write('\x1B[B'); // -> poll
    await flushAsync();
    stdin.write('\x1B[B'); // -> faceProvider
    await flushAsync();
    stdin.write(' '); // toggle -> human
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).not.toContain('CompreFace URL');

    expect(mockSaveConfig).toHaveBeenCalled();
    const lastCall = mockSaveConfig.mock.calls[mockSaveConfig.mock.calls.length - 1][0] as CliConfig;
    expect(lastCall.node?.faceProvider).toBe('human');
    expect(lastCall.node?.comprefaceUrl).toBeUndefined();
  });
});
