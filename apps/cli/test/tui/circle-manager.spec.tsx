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

function flushAsync(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('CircleManager — set active circle', () => {
  it('persists AND propagates the selected circle to the parent', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);
    const onConfigChange = jest.fn();

    const { stdin } = render(
      <CircleManager
        config={BASE_CONFIG}
        onConfigChange={onConfigChange}
        onBack={() => {}}
      />,
    );

    // Let the circle list load (loading → ready).
    await flushAsync();

    // Press Enter to select the first (pre-highlighted) circle.
    stdin.write('\r');
    await flushAsync();

    const expected = { ...BASE_CONFIG, activeCircleId: 'circle-1' };
    expect(mockSaveConfig).toHaveBeenCalledWith(expected);
    expect(onConfigChange).toHaveBeenCalledWith(expected);
  });

  it('propagates the circle the user navigated to', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);
    const onConfigChange = jest.fn();

    const { stdin } = render(
      <CircleManager
        config={BASE_CONFIG}
        onConfigChange={onConfigChange}
        onBack={() => {}}
      />,
    );

    await flushAsync();

    // Move down to the second circle, then select it.
    stdin.write('[B'); // down arrow
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const expected = { ...BASE_CONFIG, activeCircleId: 'circle-2' };
    expect(mockSaveConfig).toHaveBeenCalledWith(expected);
    expect(onConfigChange).toHaveBeenCalledWith(expected);
  });

  it('does not throw when onConfigChange is omitted', async () => {
    mockListCircles.mockResolvedValue(FAKE_CIRCLES);

    const { stdin } = render(
      <CircleManager config={BASE_CONFIG} onBack={() => {}} />,
    );

    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    expect(mockSaveConfig).toHaveBeenCalledWith({
      ...BASE_CONFIG,
      activeCircleId: 'circle-1',
    });
  });
});
