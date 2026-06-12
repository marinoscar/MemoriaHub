/**
 * test/tui/settings-screen.spec.tsx
 *
 * Tests for the SettingsScreen TUI component.
 *
 * Uses ink-testing-library + an in-memory SQLite DB.
 * Verifies list rendering, editing/saving valid values, rejection of invalid
 * values, and cancel-without-save behaviour.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { openDb } from '../../src/db/database.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { SettingsScreen } from '../../src/tui/SettingsScreen.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait a tick for React/Ink to flush state updates. */
function flushAsync(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SettingsScreen', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Initial list view
  // -------------------------------------------------------------------------

  it('renders without crashing', () => {
    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    expect(lastFrame()).toBeTruthy();
  });

  it('shows the screen title', () => {
    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Settings');
  });

  it('lists concurrency setting with default value', () => {
    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('concurrency');
    expect(plain).toContain('3'); // default value
  });

  it('lists attempts_cap setting with default value', () => {
    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('attempts_cap');
    expect(plain).toContain('5'); // default value
  });

  it('shows pre-saved value when a setting was already set', () => {
    const repo = new SettingsRepo(db);
    repo.set('concurrency', 8);

    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('8');
  });

  it('shows footer key hints', () => {
    const { lastFrame } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[Enter]');
    expect(plain).toContain('[Esc/q]');
  });

  // -------------------------------------------------------------------------
  // onBack callback
  // -------------------------------------------------------------------------

  it('calls onBack when q is pressed on the list', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <SettingsScreen db={db} onBack={onBack} />,
    );

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when Esc is pressed on the list', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <SettingsScreen db={db} onBack={onBack} />,
    );

    stdin.write('\x1B'); // ESC
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Edit + save valid value
  // -------------------------------------------------------------------------

  it('persists a valid integer value after submitting', async () => {
    const repo = new SettingsRepo(db);

    // concurrency is the first item in SelectInput — pressing Enter selects it
    const { stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Select the first item (concurrency) by pressing Enter
    stdin.write('\r');
    await flushAsync();

    // Clear the pre-filled default '3' with backspace, then type new value
    stdin.write('\x7f'); // backspace to clear '3'
    await flushAsync();
    stdin.write('7');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    // Re-read from DB to confirm persistence
    const saved = repo.get<number>('concurrency', 3);
    expect(saved).toBe(7);
  });

  it('shows success confirmation after saving', async () => {
    const { lastFrame, stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Select first item (concurrency)
    stdin.write('\r');
    await flushAsync();

    // Clear the pre-filled default '3', type new value and submit
    stdin.write('\x7f'); // backspace
    await flushAsync();
    stdin.write('4');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Saved');
    expect(plain).toContain('concurrency');
  });

  it('shows updated value in list after saving', async () => {
    const { lastFrame, stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Select first item (concurrency), clear default '3', set to 10
    stdin.write('\r');
    await flushAsync();
    stdin.write('\x7f'); // clear '3'
    await flushAsync();
    stdin.write('10');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('10');
  });

  // -------------------------------------------------------------------------
  // Edit + invalid value rejection
  // -------------------------------------------------------------------------

  it('shows error and does NOT persist when submitting 0', async () => {
    const repo = new SettingsRepo(db);

    const { lastFrame, stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Select first item (concurrency)
    stdin.write('\r');
    await flushAsync();

    // Clear the pre-filled default '3', then submit invalid value '0'
    stdin.write('\x7f'); // backspace to clear '3'
    await flushAsync();
    stdin.write('0');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // Error should be shown
    expect(plain).toContain('positive integer');

    // DB should still hold the default
    const saved = repo.get<number>('concurrency', 3);
    expect(saved).toBe(3);
  });

  it('shows error and does NOT persist when submitting a non-number', async () => {
    const repo = new SettingsRepo(db);

    const { lastFrame, stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Select first item (concurrency)
    stdin.write('\r');
    await flushAsync();

    // Submit invalid value "abc"
    stdin.write('abc');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('positive integer');

    // DB should still hold the default
    const saved = repo.get<number>('concurrency', 3);
    expect(saved).toBe(3);
  });

  it('does NOT persist when submitting a negative integer', async () => {
    const repo = new SettingsRepo(db);

    const { stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    stdin.write('\r');
    await flushAsync();

    // Negative value — note: TextInput may not accept '-' but we test validation
    // by using a string that parseInt would return negative for
    stdin.write('-1');
    await flushAsync();
    stdin.write('\r');
    await flushAsync();

    const saved = repo.get<number>('concurrency', 3);
    expect(saved).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Cancel edit (Esc while editing)
  // -------------------------------------------------------------------------

  it('returns to list without saving when Esc is pressed during edit', async () => {
    const repo = new SettingsRepo(db);

    const { lastFrame, stdin } = render(
      <SettingsScreen db={db} onBack={() => {}} />,
    );

    // Enter edit mode for concurrency
    stdin.write('\r');
    await flushAsync();

    // Clear default and type a partial new value, then cancel with Esc
    stdin.write('\x7f'); // clear '3'
    await flushAsync();
    stdin.write('9');
    await flushAsync();
    stdin.write('\x1B'); // ESC — cancel edit
    await flushAsync();

    // Should be back on the list
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('concurrency');
    expect(plain).toContain('attempts_cap');

    // DB should be unchanged (still default)
    const saved = repo.get<number>('concurrency', 3);
    expect(saved).toBe(3);
  });

  it('does NOT call onBack when Esc is pressed during edit', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <SettingsScreen db={db} onBack={onBack} />,
    );

    // Enter edit mode
    stdin.write('\r');
    await flushAsync();

    // Press Esc — should cancel edit, NOT exit screen
    stdin.write('\x1B');
    await flushAsync();

    expect(onBack).not.toHaveBeenCalled();
  });
});
