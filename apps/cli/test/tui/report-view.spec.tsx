/**
 * test/tui/report-view.spec.tsx
 *
 * Tests for the ReportView TUI component — the generic report renderer that
 * replaced StatusScreen. Uses ink-testing-library + an in-memory SQLite DB
 * seeded via the repos. better-sqlite3 is synchronous so no async setup is
 * needed for seeding.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import { RunRepo } from '../../src/repo/runs.js';
import { ReportView } from '../../src/tui/ReportView.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ReportView', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Unknown report
  // -------------------------------------------------------------------------

  it('shows an "Unknown report" message for an unregistered reportId', () => {
    const { lastFrame } = render(
      <ReportView db={db} reportId="not-a-real-report" onBack={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Unknown report');
  });

  // -------------------------------------------------------------------------
  // overview
  // -------------------------------------------------------------------------

  describe('reportId="overview"', () => {
    it('shows the folder path and title', () => {
      const folderRepo = new FolderRepo(db);
      folderRepo.add({ path: '/tmp/overview-photos', recursive: false });

      const { lastFrame } = render(
        <ReportView db={db} reportId="overview" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Folder overview');
      expect(plain).toContain('overview-photos');
    });

    it('shows uploaded/failed counts for a folder with files', () => {
      const folderRepo = new FolderRepo(db);
      const folder = folderRepo.add({ path: '/tmp/overview-counts', recursive: false });

      const fileRepo = new FileRepo(db);
      fileRepo.upsert(folder.id, '/tmp/overview-counts/a.jpg', { status: 'uploaded' });
      fileRepo.upsert(folder.id, '/tmp/overview-counts/b.jpg', { status: 'uploaded' });
      fileRepo.upsert(folder.id, '/tmp/overview-counts/c.jpg', { status: 'failed' });

      const { lastFrame } = render(
        <ReportView db={db} reportId="overview" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('overview-counts');
    });

    it('shows "No data." when no folders are registered', () => {
      const { lastFrame } = render(
        <ReportView db={db} reportId="overview" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('No data.');
    });
  });

  // -------------------------------------------------------------------------
  // runs
  // -------------------------------------------------------------------------

  describe('reportId="runs"', () => {
    it('shows the recent-runs title and trigger for a seeded run', () => {
      const runRepo = new RunRepo(db);
      const runId = runRepo.startRun({ trigger: 'manual', folderIds: [], total: 5 });
      runRepo.finishRun(runId, { uploaded: 3, skipped: 1, failed: 1 });

      const { lastFrame } = render(
        <ReportView db={db} reportId="runs" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Recent runs');
      expect(plain).toContain('manual');
    });

    it('shows "No data." when no runs have been recorded', () => {
      const { lastFrame } = render(
        <ReportView db={db} reportId="runs" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('No data.');
    });
  });

  // -------------------------------------------------------------------------
  // storage
  // -------------------------------------------------------------------------

  describe('reportId="storage"', () => {
    it('shows the "Storage synced" label and a formatted bytes value', () => {
      const folderRepo = new FolderRepo(db);
      const folder = folderRepo.add({ path: '/tmp/storage-report', recursive: false });

      const fileRepo = new FileRepo(db);
      fileRepo.upsert(folder.id, '/tmp/storage-report/a.jpg', {
        status: 'uploaded',
        size_bytes: 1_048_576, // 1 MB
      });

      const { lastFrame } = render(
        <ReportView db={db} reportId="storage" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Storage synced');
      expect(plain).toContain('MB');
    });

    it('shows 0 B when no files have been uploaded', () => {
      const { lastFrame } = render(
        <ReportView db={db} reportId="storage" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Storage synced');
      expect(plain).toContain('0 B');
    });
  });

  // -------------------------------------------------------------------------
  // duplicates
  // -------------------------------------------------------------------------

  describe('reportId="duplicates"', () => {
    it('shows a file skipped for skip_reason=dedup but not one skipped for skip_reason=unchanged', () => {
      const folderRepo = new FolderRepo(db);
      const folder = folderRepo.add({ path: '/tmp/dupes-report', recursive: false });

      const fileRepo = new FileRepo(db);
      fileRepo.upsert(folder.id, '/tmp/dupes-report/dedup.jpg', {
        status: 'skipped',
        skip_reason: 'dedup',
      });
      fileRepo.upsert(folder.id, '/tmp/dupes-report/unchanged.jpg', {
        status: 'skipped',
        skip_reason: 'unchanged',
      });

      const { lastFrame } = render(
        <ReportView db={db} reportId="duplicates" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Duplicates');
      expect(plain).toContain('dedup.jpg');
      expect(plain).not.toContain('unchanged.jpg');
    });

    it('shows "No data." when there are no duplicates', () => {
      const { lastFrame } = render(
        <ReportView db={db} reportId="duplicates" onBack={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('No data.');
    });
  });

  // -------------------------------------------------------------------------
  // onBack callback
  // -------------------------------------------------------------------------

  it('calls onBack when Esc is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <ReportView db={db} reportId="overview" onBack={onBack} />,
    );

    stdin.write('\x1B'); // ESC
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when q is pressed', async () => {
    const onBack = jest.fn();
    const { stdin } = render(
      <ReportView db={db} reportId="overview" onBack={onBack} />,
    );

    stdin.write('q');
    await flushAsync();

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
