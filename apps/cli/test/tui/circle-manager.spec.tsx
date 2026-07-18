/**
 * test/tui/circle-manager.spec.tsx
 *
 * Tests for the CircleManager TUI component.
 *
 * Mocks:
 *   - ApiClient.listCircles — returns a fixed circle list
 *   - saveConfig — captures the persisted config
 *
 * Regression focus: selecting a circle must BOTH persist via saveConfig AND
 * propagate the updated config to the parent via onConfigChange, so the running
 * session (sync dashboard, home) sees the new activeCircleId. Previously only
 * saveConfig was called, so a subsequent sync failed with "No target circle".
 */

import { jest } from '@jest/globals';
import React from 'react';
import type { Circle } from '../../src/api.js';
import { waitForFrame, waitForCalls } from './wait-for.js';

// ---------------------------------------------------------------------------
// Mock ApiClient
// ---------------------------------------------------------------------------
const FAKE_CIRCLES: Circle[] = [
  { id: 'circle-1', name: 'Personal', isPersonal: true } as Circle,
  { id: 'circle-2', name: 'Family', isPersonal: false } as Circle,
];

const mockListCircles = jest.fn<() => Promise<Circle[]>>();
jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    listCircles: mockListCircles,
  })),
  ApiError: class ApiError extends Error {},
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
// Dynamic imports AFTER mocks
// ---------------------------------------------------------------------------
const { render, cleanup } = await import('ink-testing-library');
const { CircleManager } = await import('../../src/tui/CircleManager.js');

const BASE_CONFIG = { serverUrl: 'https://test.server', pat: 'pat-123' };

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('CircleManager — set active circle', () => {
  it('persists AND propagates the selected circle to the parent', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);
    const onConfigChange = jest.fn();

    const { lastFrame, stdin } = render(
      <CircleManager
        config={BASE_CONFIG}
        onConfigChange={onConfigChange}
        onBack={() => {}}
      />,
    );

    // Let the circle list load (loading → ready) — poll for the loaded
    // content rather than sleeping a fixed duration (see wait-for.ts).
    await waitForFrame(lastFrame, (f) => f.includes('Personal'));

    // Press Enter to select the first (pre-highlighted) circle.
    stdin.write('\r');
    await waitForCalls(mockSaveConfig);

    const expected = { ...BASE_CONFIG, activeCircleId: 'circle-1' };
    expect(mockSaveConfig).toHaveBeenCalledWith(expected);
    expect(onConfigChange).toHaveBeenCalledWith(expected);
  });

  it('propagates the circle the user navigated to', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);
    const onConfigChange = jest.fn();

    const { lastFrame, stdin } = render(
      <CircleManager
        config={BASE_CONFIG}
        onConfigChange={onConfigChange}
        onBack={() => {}}
      />,
    );

    await waitForFrame(lastFrame, (f) => f.includes('Personal'));

    // Move down to the second circle, and wait for the highlight ('▶') to
    // actually move onto the Family row before pressing Enter — the arrow
    // and Enter keys are handled by the SAME useInput callback here (unlike
    // ink-select-input's own internal index in the menu-nav test), but
    // `selected` is only updated via React state, so sending Enter before
    // that state update (and re-render capturing it in a fresh closure) has
    // committed still reads the stale `selected` and picks the wrong row.
    stdin.write('\x1B[B'); // down arrow
    await waitForFrame(lastFrame, (f) => {
      const line = f.split('\n').find((l) => l.includes('Family'));
      return !!line && line.includes('▶');
    });

    stdin.write('\r');
    await waitForCalls(mockSaveConfig);

    const expected = { ...BASE_CONFIG, activeCircleId: 'circle-2' };
    expect(mockSaveConfig).toHaveBeenCalledWith(expected);
    expect(onConfigChange).toHaveBeenCalledWith(expected);
  });

  it('does not throw when onConfigChange is omitted', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);

    const { lastFrame, stdin } = render(
      <CircleManager config={BASE_CONFIG} onBack={() => {}} />,
    );

    await waitForFrame(lastFrame, (f) => f.includes('Personal'));
    stdin.write('\r');
    await waitForCalls(mockSaveConfig);

    expect(mockSaveConfig).toHaveBeenCalledWith({
      ...BASE_CONFIG,
      activeCircleId: 'circle-1',
    });
  });
});
