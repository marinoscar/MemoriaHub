/**
 * test/tui/login-screen.spec.tsx
 *
 * Tests for the LoginScreen TUI component using the device authorization flow.
 *
 * Mocks:
 *   - device-auth (requestDeviceCode, pollForDeviceToken)
 *   - ApiClient.get — /api/auth/me
 *   - saveConfig
 *   - open-browser — openBrowser (no-op)
 *   - os — hostname / platform
 *
 * Test strategy:
 *   We pre-populate the server URL via `initialConfig` (which sets the default
 *   state for the TextInput), then send `\r` once to trigger `onSubmit` with
 *   that pre-set value. This avoids the React batching race where a `onChange`
 *   state update hasn't propagated back to the TextInput's `value` prop before
 *   the next `stdin.write('\r')` fires `onSubmit`.
 *
 * Assertions:
 *   - After submitting the URL the device box renders the userCode
 *   - Once poll resolves and /api/auth/me succeeds, shows "Logged in as …"
 *   - onDone is called after the 1.5s success delay
 *   - NO "Personal Access Token" prompt appears at any point
 *   - Error state: shows error message; pressing 'r' resets to url step
 *
 * Timing: we use jest fake timers to control the 1.5s success setTimeout.
 */

import { jest } from '@jest/globals';
import React from 'react';

// ---------------------------------------------------------------------------
// Fake os module — must be declared BEFORE the mocks that import os
// ---------------------------------------------------------------------------
jest.unstable_mockModule('os', () => {
  const mod = {
    hostname: jest.fn(() => 'test-host'),
    platform: jest.fn(() => 'linux'),
  };
  return { ...mod, default: mod };
});

// ---------------------------------------------------------------------------
// Mock open-browser — no-op
// ---------------------------------------------------------------------------
jest.unstable_mockModule('../../src/open-browser.js', () => ({
  openBrowser: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock device-auth
// ---------------------------------------------------------------------------
const fakeDeviceCode = {
  deviceCode: 'dev-code-abc',
  userCode: 'ABCD-1234',
  verificationUri: 'https://example.com/activate',
  verificationUriComplete: 'https://example.com/activate?user_code=ABCD-1234',
  interval: 1,
  expiresIn: 900,
};

const mockRequestDeviceCode = jest.fn<() => Promise<typeof fakeDeviceCode>>();
const mockPollForDeviceToken = jest.fn<() => Promise<string>>();

jest.unstable_mockModule('../../src/device-auth.js', () => ({
  requestDeviceCode: mockRequestDeviceCode,
  pollForDeviceToken: mockPollForDeviceToken,
}));

// ---------------------------------------------------------------------------
// Mock ApiClient
// ---------------------------------------------------------------------------
const mockApiGet = jest.fn<() => Promise<{ email: string }>>();
jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    get: mockApiGet,
  })),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public serverMessage: string) {
      super(`API error ${status}: ${serverMessage}`);
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock saveConfig
// ---------------------------------------------------------------------------
const mockSaveConfig = jest.fn();
jest.unstable_mockModule('../../src/config.js', () => ({
  saveConfig: mockSaveConfig,
  loadConfig: jest.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Dynamic imports AFTER all unstable_mockModule declarations
// ---------------------------------------------------------------------------
const { render, cleanup } = await import('ink-testing-library');
const { LoginScreen } = await import('../../src/tui/LoginScreen.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait a tick (or more) for React/Ink to flush async state updates (real timers). */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Flush microtasks only (no setTimeout dependency).
 * Safe to use inside jest.useFakeTimers() blocks.
 */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Server URL to pre-populate. Using initialConfig so it is already in state
 * when the component mounts — no need to type it character-by-character.
 */
const SERVER_URL = 'https://test.server';
const FAKE_INITIAL_CONFIG = { serverUrl: SERVER_URL, pat: '' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('LoginScreen — device authorization flow', () => {
  // -------------------------------------------------------------------------
  // Initial render: URL input
  // -------------------------------------------------------------------------

  it('renders the Server URL input on initial mount', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame } = render(
      <LoginScreen initialConfig={null} onDone={() => {}} onBack={() => {}} />,
    );

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Server URL');
    expect(plain).toContain('MemoriaHub');
  });

  it('pre-fills the Server URL from initialConfig', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain(SERVER_URL);
  });

  // -------------------------------------------------------------------------
  // Does NOT show a PAT prompt — ever
  // -------------------------------------------------------------------------

  it('does NOT render a "Personal Access Token" prompt on initial mount', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame } = render(
      <LoginScreen initialConfig={null} onDone={() => {}} onBack={() => {}} />,
    );

    const plain = stripAnsi(lastFrame()!);
    expect(plain).not.toContain('Personal Access Token');
    expect(plain).not.toContain('paste your PAT');
  });

  it('does NOT render a PAT prompt after advancing to device step', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    // Submit the pre-populated URL
    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).not.toContain('Personal Access Token');
    expect(plain).not.toContain('paste your PAT');
  });

  // -------------------------------------------------------------------------
  // After URL submit: device box shows userCode
  // -------------------------------------------------------------------------

  it('shows the userCode in a device box after submitting the URL', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    // Keep poll pending so we can inspect
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('ABCD-1234');
    expect(plain).toContain('https://example.com/activate');
  });

  it('shows the verification URI complete link in the device box', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('ABCD-1234');
    expect(plain).toContain('activate?user_code=ABCD-1234');
  });

  it('shows the expiry hint in the device box', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode); // expiresIn: 900 → 15 min
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('15 minutes');
  });

  it('calls requestDeviceCode with the submitted URL and correct clientInfo', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    expect(mockRequestDeviceCode).toHaveBeenCalledWith(
      SERVER_URL,
      expect.objectContaining({ tokenType: 'pat', name: 'MemoriaHub CLI' }),
    );
  });

  // -------------------------------------------------------------------------
  // Full happy path: poll resolves → validate → success → onDone
  // -------------------------------------------------------------------------

  it('shows "Logged in as me@example.com" once poll + validate succeed', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');

    // Allow all async operations (requestDeviceCode → device step → pollForDeviceToken
    // → validating → ApiClient.get) to resolve through microtask + render cycles.
    await flushAsync(200);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Logged in as me@example.com');
  });

  it('calls saveConfig with the token returned by pollForDeviceToken', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockResolvedValue('pat_from_device_flow');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(200);

    expect(mockSaveConfig).toHaveBeenCalledWith({
      serverUrl: SERVER_URL,
      pat: 'pat_from_device_flow',
    });
  });

  it('calls onDone after the 1.5s success delay', async () => {
    // Use real timers so we can simply await the full flow including the
    // 1.5s display delay.  The jest.config timeout is 15s so this is fine.
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const onDone = jest.fn();

    const { stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={onDone}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');

    // Wait for all async steps + the 1.5s onDone delay to complete.
    await flushAsync(2000);

    expect(onDone).toHaveBeenCalledWith({
      serverUrl: SERVER_URL,
      pat: 'pat_test',
    });
  });

  // -------------------------------------------------------------------------
  // requestDeviceCode failure → error step
  // -------------------------------------------------------------------------

  it('shows error message when requestDeviceCode fails', async () => {
    mockRequestDeviceCode.mockRejectedValue(new Error('Network unreachable'));
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Network unreachable');
  });

  // -------------------------------------------------------------------------
  // pollForDeviceToken failure → error step
  // -------------------------------------------------------------------------

  it('shows error message when pollForDeviceToken rejects (e.g. expired)', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockRejectedValue(new Error('Device code expired'));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Device code expired');
  });

  // -------------------------------------------------------------------------
  // Retry from error step
  // -------------------------------------------------------------------------

  it('resets to url step when user presses "r" in error state', async () => {
    mockRequestDeviceCode.mockRejectedValue(new Error('Temporary error'));
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    // Should be in error state
    expect(stripAnsi(lastFrame()!)).toContain('Temporary error');

    // Now press 'r' to retry
    stdin.write('r');
    await flushAsync(50);

    // Should show the Server URL input again
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Server URL');
  });

  it('shows retry hint text in error state', async () => {
    mockRequestDeviceCode.mockRejectedValue(new Error('Connection refused'));
    mockPollForDeviceToken.mockResolvedValue('pat_test');
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const { lastFrame, stdin } = render(
      <LoginScreen
        initialConfig={FAKE_INITIAL_CONFIG}
        onDone={() => {}}
        onBack={() => {}}
      />,
    );

    stdin.write('\r');
    await flushAsync(150);

    const plain = stripAnsi(lastFrame()!);
    // Should show retry instructions
    expect(plain).toContain('retry');
  });

  // -------------------------------------------------------------------------
  // onBack is called when Esc is pressed
  // -------------------------------------------------------------------------

  it('calls onBack when Esc is pressed in the url step', async () => {
    mockRequestDeviceCode.mockResolvedValue(fakeDeviceCode);
    mockPollForDeviceToken.mockReturnValue(new Promise(() => {}));
    mockApiGet.mockResolvedValue({ email: 'me@example.com' });

    const onBack = jest.fn();

    const { stdin } = render(
      <LoginScreen initialConfig={null} onDone={() => {}} onBack={onBack} />,
    );

    // Send Escape key (\x1b is the ASCII escape character that ink maps to key.escape)
    stdin.write('\x1b');
    await flushAsync(50);

    expect(onBack).toHaveBeenCalled();
  });
});
