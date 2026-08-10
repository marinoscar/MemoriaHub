/**
 * Unit tests for the Database Backup run-table column contract (issue #345).
 *
 * These cover the two display decisions the columns encode that a reader could
 * otherwise mistake for API fields:
 *   - `verified` is DERIVED from `completed` + `verifiedAt`, and must not leak
 *     into `value()` (which feeds the `?status=` filter and CSV export).
 *   - `pre_restore` is visually distinguished from the two intentional triggers.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  DB_BACKUP_RUNS_TABLE_ID,
  DbBackupStatusChip,
  DbBackupTriggerCell,
  buildDbBackupRunColumns,
  displayStatus,
  runSizeBytes,
} from '../../pages/Admin/dbBackupTable';
import type { DbBackupRunDto } from '../../services/dbBackup';

function makeRun(overrides: Partial<DbBackupRunDto> = {}): DbBackupRunDto {
  return {
    id: 'run-1',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-08-09T02:00:00.000Z',
    finishedAt: '2026-08-09T02:10:00.000Z',
    lastHeartbeatAt: '2026-08-09T02:10:00.000Z',
    verifiedAt: '2026-08-09T02:10:30.000Z',
    elapsedMs: 600_000,
    bytesWritten: '2147483648',
    sizeBytes: '2147483648',
    storageProvider: 's3',
    storageKey: 'k',
    bucket: 'b',
    format: 'custom',
    checksumSha256: 'a'.repeat(64),
    dbVersion: '16.2',
    appVersion: '1.0.0',
    migrationName: 'm',
    lastError: null,
    createdById: null,
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    ...overrides,
  };
}

describe('dbBackupTable', () => {
  it('uses a stable table id for per-user layout persistence', () => {
    expect(DB_BACKUP_RUNS_TABLE_ID).toBe('admin-db-backup-runs');
  });

  it('derives "verified" from completed + verifiedAt', () => {
    expect(displayStatus(makeRun())).toBe('verified');
    expect(displayStatus(makeRun({ verifiedAt: null }))).toBe('completed');
    expect(displayStatus(makeRun({ status: 'failed', verifiedAt: null }))).toBe(
      'failed',
    );
  });

  it('keeps the raw API status in value(), so the filter and export stay honest', () => {
    const statusCol = buildDbBackupRunColumns().find((c) => c.id === 'status')!;
    expect(statusCol.value!(makeRun())).toBe('completed');
  });

  it('renders the verified chip for a verified run', () => {
    render(<DbBackupStatusChip run={makeRun()} />);
    expect(screen.getByText('verified')).toBeInTheDocument();
  });

  it('renders a distinct chip for a pre-restore trigger', () => {
    render(<DbBackupTriggerCell trigger="pre_restore" />);
    expect(screen.getByText('pre-restore')).toBeInTheDocument();
  });

  it('renders plain text for manual and scheduled triggers', () => {
    const { rerender } = render(<DbBackupTriggerCell trigger="manual" />);
    expect(screen.getByText('manual')).toBeInTheDocument();
    rerender(<DbBackupTriggerCell trigger="scheduled" />);
    expect(screen.getByText('scheduled')).toBeInTheDocument();
  });

  it('falls back to the live byte counter while sizeBytes is unknown', () => {
    expect(runSizeBytes(makeRun())).toBe('2147483648');
    expect(runSizeBytes(makeRun({ sizeBytes: null, bytesWritten: '512' }))).toBe(
      '512',
    );
  });

  it('declares no sortable column, since GET /runs accepts no sort parameter', () => {
    expect(buildDbBackupRunColumns().some((c) => c.sortable)).toBe(false);
  });

  it('assigns every column a priority', () => {
    for (const col of buildDbBackupRunColumns()) {
      expect(['primary', 'secondary', 'detail']).toContain(col.priority);
    }
  });
});
