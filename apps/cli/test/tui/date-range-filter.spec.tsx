/**
 * test/tui/date-range-filter.spec.tsx
 *
 * Tests for the DateRangeFilter Ink screen (src/tui/DateRangeFilter.tsx).
 *
 * The component only depends on the pure sync/date-range.js helpers and the
 * theme module — no fs/network — so no jest.unstable_mockModule is needed
 * here (unlike the sync-engine date-range tests). Harness mirrors
 * test/tui/folder-manager.spec.tsx / test/tui/login-screen.spec.tsx:
 * ink-testing-library's render()/stdin, ANSI-stripped frame assertions, and
 * a real-timer flushAsync() between keystrokes and assertions.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DateRangeFilter } from '../../src/tui/DateRangeFilter.js';
import type { DateRange } from '../../src/sync/date-range.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences so text assertions are colour-independent. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait for React/Ink to flush state updates. */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DateRangeFilter', () => {
  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  it('renders the title and the initial "all dates" preview', () => {
    const { lastFrame } = render(
      <DateRangeFilter onApply={() => {}} onBack={() => {}} />,
    );

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Date range filter');
    expect(plain).toContain('Syncing: all dates');
  });

  // -------------------------------------------------------------------------
  // Typing a valid date into the (initially focused) From field
  // -------------------------------------------------------------------------

  it('updates the preview to "on/after <date>" when a valid date is typed into From', async () => {
    const { lastFrame, stdin } = render(
      <DateRangeFilter onApply={() => {}} onBack={() => {}} />,
    );

    stdin.write('2023-01-01');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('on/after 2023-01-01');
  });

  it('updates the preview to a "From → To" range when both fields are filled', async () => {
    const { lastFrame, stdin } = render(
      <DateRangeFilter onApply={() => {}} onBack={() => {}} />,
    );

    stdin.write('2023-01-01'); // From
    await flushAsync();

    stdin.write('\x1B[B'); // down arrow -> focus To
    await flushAsync();

    stdin.write('2023-01-31'); // To
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('2023-01-01 → 2023-01-31');
  });

  // -------------------------------------------------------------------------
  // Invalid input (From after To): error shown, Enter blocked
  // -------------------------------------------------------------------------

  it('shows an inline error and blocks Enter when From is after To', async () => {
    const onApply = jest.fn();
    const { lastFrame, stdin } = render(
      <DateRangeFilter onApply={onApply} onBack={() => {}} />,
    );

    stdin.write('2023-06-01'); // From — later date
    await flushAsync();

    stdin.write('\x1B[B'); // focus -> To
    await flushAsync();

    stdin.write('2023-01-01'); // To — earlier than From: invalid range
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('--from must be on or before --to');

    stdin.write('\r');
    await flushAsync();

    expect(onApply).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Enter with valid/empty input calls onApply
  // -------------------------------------------------------------------------

  it('calls onApply with {} when Enter is pressed with both fields empty', async () => {
    const onApply = jest.fn();
    const { stdin } = render(
      <DateRangeFilter onApply={onApply} onBack={() => {}} />,
    );

    stdin.write('\r');
    await flushAsync();

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({});
  });

  it('calls onApply with the parsed range when Enter is pressed with a valid From date', async () => {
    const onApply = jest.fn();
    const { stdin } = render(
      <DateRangeFilter onApply={onApply} onBack={() => {}} />,
    );

    stdin.write('2023-01-01');
    await flushAsync();

    stdin.write('\r');
    await flushAsync();

    expect(onApply).toHaveBeenCalledTimes(1);
    const arg = onApply.mock.calls[0][0] as DateRange;
    expect(arg.fromMs).toBe(new Date(2023, 0, 1, 0, 0, 0, 0).getTime());
    expect(arg.toMs).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Esc / q -> onBack
  // -------------------------------------------------------------------------

  it('calls onBack when Esc is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <DateRangeFilter onApply={() => {}} onBack={onBack} />,
    );

    stdin.write('\x1B');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when q is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <DateRangeFilter onApply={() => {}} onBack={onBack} />,
    );

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not leak the "q" back-command keystroke into the focused field', async () => {
    // 'q' is stripped by the field sanitizer, so pressing it should trigger
    // onBack without also appending a stray 'q' character to fromStr.
    const onBack = jest.fn();
    const { lastFrame, stdin } = render(
      <DateRangeFilter onApply={() => {}} onBack={onBack} />,
    );

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Syncing: all dates');
  });
});
