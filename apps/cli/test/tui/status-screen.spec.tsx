/**
 * test/tui/status-screen.spec.tsx
 *
 * Tests for the StatusScreen TUI component.
 *
 * Uses ink-testing-library + an in-memory SQLite DB seeded via the repos.
 * better-sqlite3 is synchronous so no async setup is needed for seeding.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import { RunRepo } from '../../src/repo/runs.js';
import { StatusScreen } from '../../src/tui/StatusScreen.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait a tick for React/Ink to flush state updates. */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('StatusScreen', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('renders without crashing when no folders are registered', () => {
    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    expect(lastFrame()).toBeTruthy();
  });

  it('shows empty-state message when no folders are registered', () => {
    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No folders registered');
  });

  // -------------------------------------------------------------------------
  // Folder table
  // -------------------------------------------------------------------------

  it('renders the title with folder count', () => {
    const folderRepo = new FolderRepo(db);
    folderRepo.add({ path: '/tmp/photos', recursive: false });

    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Status');
    expect(plain).toContain('1 folder');
  });

  it('shows the folder path in the table', () => {
    const folderRepo = new FolderRepo(db);
    folderRepo.add({ path: '/tmp/myphotos', recursive: false });

    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('myphotos');
  });

  it('shows uploaded count for a folder with uploaded files', () => {
    const folderRepo = new FolderRepo(db);
    const folder = folderRepo.add({ path: '/tmp/upload-test', recursive: false });

    const fileRepo = new FileRepo(db);
    fileRepo.upsert(folder.id, '/tmp/upload-test/a.jpg', { status: 'uploaded' });
    fileRepo.upsert(folder.id, '/tmp/upload-test/b.jpg', { status: 'uploaded' });
    fileRepo.upsert(folder.id, '/tmp/upload-test/c.jpg', { status: 'queued' });
    fileRepo.upsert(folder.id, '/tmp/upload-test/d.jpg', { status: 'failed' });

    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    // 2 uploaded, 1 queued, 1 failed — all these counts should appear
    expect(plain).toContain('2');
    expect(plain).toContain('1');
  });

  it('shows multiple folders in the table', () => {
    const folderRepo = new FolderRepo(db);
    folderRepo.add({ path: '/tmp/alpha', recursive: false });
    folderRepo.add({ path: '/tmp/beta', recursive: true });

    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('alpha');
    expect(plain).toContain('beta');
    expect(plain).toContain('2 folder');
  });

  // -------------------------------------------------------------------------
  // Footer hint
  // -------------------------------------------------------------------------

  it('shows the key hint footer', () => {
    const { lastFrame } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[r]');
    expect(plain).toContain('[Esc/q]');
  });

  // -------------------------------------------------------------------------
  // Runs toggle
  // -------------------------------------------------------------------------

  it('shows runs view after pressing r', async () => {
    // Seed one run so the view is non-empty
    const runRepo = new RunRepo(db);
    const runId = runRepo.startRun({ trigger: 'manual', folderIds: [], total: 5 });
    runRepo.finishRun(runId, { uploaded: 3, skipped: 1, failed: 1 });

    const { lastFrame, stdin } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );

    stdin.write('r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    // Runs view shows trigger and counts
    expect(plain).toContain('manual');
  });

  it('toggles back to folders view after pressing r twice', async () => {
    const folderRepo = new FolderRepo(db);
    folderRepo.add({ path: '/tmp/toggle-test', recursive: false });

    const { lastFrame, stdin } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );

    // Toggle to runs
    stdin.write('r');
    await flushAsync();

    // Toggle back to folders
    stdin.write('r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('toggle-test');
  });

  it('shows empty runs message when no runs recorded', async () => {
    const { lastFrame, stdin } = render(
      <StatusScreen db={db} onBack={() => {}} />,
    );

    stdin.write('r');
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No sync runs');
  });

  // -------------------------------------------------------------------------
  // onBack callback
  // -------------------------------------------------------------------------

  it('calls onBack when Esc is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <StatusScreen db={db} onBack={onBack} />,
    );

    stdin.write('\x1B'); // ESC
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when q is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <StatusScreen db={db} onBack={onBack} />,
    );

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
