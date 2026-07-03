/**
 * test/tui/folder-manager.spec.tsx
 *
 * Tests for the FolderManager TUI component — focused on the remove-confirm
 * sub-screen that was fixed to handle the confirm/cancel via direct keypress
 * rather than a TextInput (avoids the controlled-input pitfall).
 *
 * Strategy:
 *   - Inject an in-memory SQLite database (openDb(':memory:')) as the `db` prop
 *     so no real ~/.memoriahub files are touched.
 *   - Seed the database with one folder via FolderRepo.
 *   - Simulate user keypresses via ink-testing-library's `stdin`.
 *   - Assert rendered output and database state after each interaction.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FolderManager } from '../../src/tui/FolderManager.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences so text assertions are colour-independent. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait for React/Ink to flush state updates. */
function flushAsync(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('FolderManager — remove confirm sub-screen', () => {
  let db: BetterSqlite3.Database;
  let repo: FolderRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = new FolderRepo(db);
  });

  afterEach(() => {
    cleanup();
    db.close();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  it('renders the folder list without crashing', () => {
    repo.add({ path: '/tmp/test-photos' });
    const { lastFrame } = render(<FolderManager db={db} onBack={() => {}} />);
    expect(lastFrame()).toBeTruthy();
  });

  it('shows the folder path in the list', () => {
    repo.add({ path: '/tmp/test-photos' });
    const { lastFrame } = render(<FolderManager db={db} onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('test-photos');
  });

  it('shows "No folders registered" when no folders exist', () => {
    const { lastFrame } = render(<FolderManager db={db} onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No folders registered');
  });

  it('shows footer key hints', () => {
    const { lastFrame } = render(<FolderManager db={db} onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[a] add');
    expect(plain).toContain('[d] remove');
  });

  // -------------------------------------------------------------------------
  // Enter confirm-remove sub-screen (press 'd')
  // -------------------------------------------------------------------------

  it('transitions to confirm-remove screen when d is pressed', async () => {
    repo.add({ path: '/tmp/confirm-test' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Remove Folder?');
  });

  it('shows the folder path on the confirm-remove screen', async () => {
    repo.add({ path: '/tmp/confirm-test-path' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('confirm-test-path');
  });

  it('shows the [y]/[n] hint on the confirm-remove screen', async () => {
    repo.add({ path: '/tmp/hint-test' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[y] remove');
    expect(plain).toContain('[n/Esc] cancel');
  });

  // -------------------------------------------------------------------------
  // Confirm removal (press 'y')
  // -------------------------------------------------------------------------

  it('removes the folder from the DB when y is pressed on confirm screen', async () => {
    repo.add({ path: '/tmp/to-remove' });
    expect(repo.list()).toHaveLength(1); // sanity check

    const { stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('y');
    await flushAsync();

    // The DB should now have no folders
    expect(repo.list()).toHaveLength(0);
  });

  it('returns to the list view after confirming removal', async () => {
    repo.add({ path: '/tmp/to-remove-2' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('y');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // Should be back on the list view showing empty state
    expect(plain).toContain('No folders registered');
  });

  it('shows a status message confirming the removal', async () => {
    repo.add({ path: '/tmp/show-removed-msg' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('y');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Removed folder:');
  });

  it('also removes the folder when uppercase Y is pressed', async () => {
    repo.add({ path: '/tmp/uppercase-y' });
    const { stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('Y');
    await flushAsync();

    expect(repo.list()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Cancel removal (press 'n')
  // -------------------------------------------------------------------------

  it('does NOT remove the folder when n is pressed on confirm screen', async () => {
    repo.add({ path: '/tmp/do-not-remove' });
    const { stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('n');
    await flushAsync();

    // Folder must still exist in the DB
    expect(repo.list()).toHaveLength(1);
  });

  it('returns to the list view after pressing n to cancel', async () => {
    repo.add({ path: '/tmp/cancel-test' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('n');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // Should be back on the list view (not on confirm screen)
    expect(plain).not.toContain('Remove Folder?');
    // The folder path should appear again in the list
    expect(plain).toContain('cancel-test');
  });

  it('shows "Remove cancelled." status message after pressing n', async () => {
    repo.add({ path: '/tmp/cancel-msg-test' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('n');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Remove cancelled.');
  });

  it('also cancels when uppercase N is pressed', async () => {
    repo.add({ path: '/tmp/uppercase-n' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('N');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Remove cancelled.');
    expect(repo.list()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Cancel removal via Escape
  // -------------------------------------------------------------------------

  it('does NOT remove the folder when Esc is pressed on confirm screen', async () => {
    repo.add({ path: '/tmp/esc-cancel' });
    const { stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('\x1B'); // ESC key
    await flushAsync();

    expect(repo.list()).toHaveLength(1);
  });

  it('shows cancel message when Esc is pressed on confirm screen', async () => {
    repo.add({ path: '/tmp/esc-cancel-msg' });
    const { lastFrame, stdin } = render(<FolderManager db={db} onBack={() => {}} />);

    stdin.write('d');
    await flushAsync();
    stdin.write('\x1B'); // ESC key
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Remove cancelled.');
  });

  // -------------------------------------------------------------------------
  // onBack callback
  // -------------------------------------------------------------------------

  it('calls onBack when q is pressed on the list screen', async () => {
    const onBack = jest.fn();
    const { stdin } = render(<FolderManager db={db} onBack={onBack} />);

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onBack when q is pressed during confirm-remove', async () => {
    // 'q' in confirm-remove mode is treated as neither y nor n, so it should
    // fall through to the else branch and cancel (not call onBack).
    repo.add({ path: '/tmp/q-on-confirm' });
    const onBack = jest.fn();
    const { stdin } = render(<FolderManager db={db} onBack={onBack} />);

    stdin.write('d');
    await flushAsync();
    // Any key that is not y/Y/n/N/Esc/Enter on confirm-remove is ignored
    // (the handler returns early after checking confirm-remove branch)
    // So q here should NOT trigger onBack.
    stdin.write('q');
    await flushAsync();

    expect(onBack).not.toHaveBeenCalled();
  });
});
