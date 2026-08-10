/**
 * Unit tests for DbBackupPage (issue #345, epic #339).
 *
 * Mocking strategy:
 *   - `usePermissions` is module-mocked to control the admin gate and the three
 *     `db_backup:*` permissions independently.
 *   - `services/dbBackup` and `services/storage-providers` are module-mocked so
 *     no real request is made and each scenario can drive the response shape.
 *   - `components/datatable` is replaced with a minimal list renderer. The real
 *     DataGrid is heavy in jsdom (the JobsPage suite is already flaky for that
 *     reason) and none of these assertions are about grid internals — they are
 *     about the row-action contract the page declares, which the stub exposes
 *     verbatim.
 *
 * `useDbBackup` is deliberately NOT mocked: the 409 path is the interesting
 * behaviour here (the error body loses `activeRunId` to the app-wide exception
 * filter, so the hook refetches the config for it) and mocking the hook would
 * assert nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../services/dbBackup', () => ({
  getDbBackupConfig: vi.fn(),
  updateDbBackupConfig: vi.fn(),
  startDbBackupRun: vi.fn(),
  listDbBackupRuns: vi.fn(),
  getDbBackupRun: vi.fn(),
  getDbBackupDownloadUrl: vi.fn(),
  deleteDbBackupRun: vi.fn(),
  cancelDbBackupRun: vi.fn(),
}));

vi.mock('../../services/storage-providers', () => ({
  getStorageSettings: vi.fn(),
}));

vi.mock('../../components/datatable', () => ({
  DataTable: ({ rows, rowActions, rowId }: any) => (
    <div data-testid="datatable">
      {rows.map((row: any) => (
        <div key={rowId(row)} data-testid={`row-${rowId(row)}`}>
          <span>{rowId(row)}</span>
          {(rowActions ?? []).map((action: any) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled ? action.disabled(row) : false}
            >
              {action.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import DbBackupPage from '../../pages/Admin/DbBackupPage';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../services/api';
import {
  getDbBackupConfig,
  updateDbBackupConfig,
  startDbBackupRun,
  listDbBackupRuns,
  getDbBackupRun,
} from '../../services/dbBackup';
import { getStorageSettings } from '../../services/storage-providers';

const mockUsePermissions = vi.mocked(usePermissions);
const mockGetConfig = vi.mocked(getDbBackupConfig);
const mockUpdateConfig = vi.mocked(updateDbBackupConfig);
const mockStartRun = vi.mocked(startDbBackupRun);
const mockListRuns = vi.mocked(listDbBackupRuns);
const mockGetRun = vi.mocked(getDbBackupRun);
const mockGetStorageSettings = vi.mocked(getStorageSettings);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function adminPermissions(granted: string[] = [
  'db_backup:read',
  'db_backup:write',
]) {
  const set = new Set(granted);
  return {
    isAdmin: true,
    permissions: set,
    roles: new Set(['admin']),
    hasPermission: vi.fn((p: string) => set.has(p)),
    hasAnyPermission: vi.fn((...ps: string[]) => ps.some((p) => set.has(p))),
    hasAllPermissions: vi.fn((...ps: string[]) => ps.every((p) => set.has(p))),
    hasRole: vi.fn(() => true),
    hasAnyRole: vi.fn(() => true),
  } as any;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const { config: configOverrides, ...rest } = overrides;
  return {
    config: {
      enabled: true,
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      timezone: 'UTC',
      retentionCount: 7,
      storageProvider: null,
      runStaleMinutes: 30,
      compressionLevel: 1,
      restoreRollbackMode: 'retain_database',
      oldDatabaseRetentionHours: 168,
      ...(configOverrides as Record<string, unknown> | undefined),
    },
    nextRunAt: '2026-08-11T02:00:00.000Z',
    activeRunId: null,
    ...rest,
  } as any;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1111-2222',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-08-09T02:00:00.000Z',
    finishedAt: '2026-08-09T02:12:00.000Z',
    lastHeartbeatAt: '2026-08-09T02:12:00.000Z',
    verifiedAt: '2026-08-09T02:12:30.000Z',
    elapsedMs: 720_000,
    bytesWritten: '3221225472',
    sizeBytes: '3221225472',
    storageProvider: 's3',
    storageKey: 'db-backups/run-1.dump',
    bucket: 'memoria',
    format: 'custom',
    checksumSha256: 'abcdef0123456789',
    dbVersion: '16.2',
    appVersion: '1.0.0',
    migrationName: '20260808010000_add_backup_feed_foundations',
    lastError: null,
    createdById: 'user-1',
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    ...overrides,
  } as any;
}

function runsResponse(items: any[]) {
  return {
    items,
    meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 },
  } as any;
}

function storageSettings(activeProvider = 's3') {
  return {
    activeProvider,
    knownProviders: [],
    providers: [
      {
        provider: 's3',
        label: 'AWS S3',
        configured: true,
        enabled: true,
        requiresCredentials: true,
        accessKeyId: null,
        region: null,
        bucket: null,
        endpoint: null,
        last4: null,
      },
      {
        provider: 'local',
        label: 'Local disk',
        configured: true,
        enabled: true,
        requiresCredentials: false,
        accessKeyId: null,
        region: null,
        bucket: null,
        endpoint: null,
        last4: null,
      },
    ],
  } as any;
}

// ---------------------------------------------------------------------------

describe('DbBackupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions());
    mockGetConfig.mockResolvedValue(makeConfig());
    mockListRuns.mockResolvedValue(runsResponse([makeRun()]));
    mockGetStorageSettings.mockResolvedValue(storageSettings());
    mockUpdateConfig.mockResolvedValue(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  it('redirects a user without db_backup:read', async () => {
    mockUsePermissions.mockReturnValue(adminPermissions([]));
    render(<DbBackupPage />);
    await waitFor(() => {
      expect(screen.queryByText('Database Backup')).not.toBeInTheDocument();
    });
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Config form
  // -------------------------------------------------------------------------

  it('renders the config form from the loaded settings and saves it', async () => {
    const user = userEvent.setup();
    render(<DbBackupPage />);

    await screen.findByText('Configuration');
    // The server-computed next run time is surfaced, not recomputed client-side.
    await waitFor(() =>
      expect(screen.getAllByText(/Next run:/).length).toBeGreaterThan(0),
    );

    const retention = await screen.findByLabelText('Backups to keep');
    expect(retention).toHaveValue(7);

    await user.clear(retention);
    await user.type(retention, '14');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledTimes(1));
    expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
      enabled: true,
      frequency: 'daily',
      timeOfDay: '02:00',
      timezone: 'UTC',
      retentionCount: 14,
      storageProvider: null,
      restoreRollbackMode: 'retain_database',
    });
  });

  it('shows the estimated total storage beside retention, not a bare count', async () => {
    render(<DbBackupPage />);
    // 3 GiB last dump × 7 retained.
    await screen.findByText(/Estimated total storage: ~21\.00 GB/);
  });

  // -------------------------------------------------------------------------
  // Conditional day picker
  // -------------------------------------------------------------------------

  it('shows no day picker for a daily schedule', async () => {
    render(<DbBackupPage />);
    await screen.findByText('Configuration');
    expect(screen.queryByLabelText('Day of week')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  });

  it('shows the day-of-week picker for a weekly schedule', async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ config: { frequency: 'weekly' } }));
    render(<DbBackupPage />);
    await screen.findByLabelText('Day of week');
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  });

  it('shows the day-of-month picker for a monthly schedule', async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ config: { frequency: 'monthly' } }));
    render(<DbBackupPage />);
    const dom = await screen.findByLabelText('Day of month');
    expect(dom).toHaveValue(1);
    expect(screen.queryByLabelText('Day of week')).not.toBeInTheDocument();
  });

  it('swaps the picker when the frequency changes', async () => {
    const user = userEvent.setup();
    render(<DbBackupPage />);
    await screen.findByText('Configuration');

    await user.click(screen.getByLabelText('Frequency'));
    await user.click(await screen.findByRole('option', { name: 'Weekly' }));

    await screen.findByLabelText('Day of week');
  });

  // -------------------------------------------------------------------------
  // Local-provider warning
  // -------------------------------------------------------------------------

  it('warns when the resolved storage provider is local disk', async () => {
    mockGetConfig.mockResolvedValue(
      makeConfig({ config: { storageProvider: 'local' } }),
    );
    render(<DbBackupPage />);
    await screen.findByText('Backups would land on local disk');
    expect(
      screen.getByText(/no disaster-recovery value/i),
    ).toBeInTheDocument();
  });

  it('warns when the override is "use active provider" and the active one is local', async () => {
    mockGetStorageSettings.mockResolvedValue(storageSettings('local'));
    render(<DbBackupPage />);
    await screen.findByText('Backups would land on local disk');
  });

  it('does not warn for an off-host provider', async () => {
    render(<DbBackupPage />);
    await screen.findByText('Configuration');
    expect(
      screen.queryByText('Backups would land on local disk'),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Rollback mode
  // -------------------------------------------------------------------------

  it('explains the rollback-mode tradeoff for the active mode', async () => {
    render(<DbBackupPage />);
    await screen.findByText(/rolling back takes seconds/i);
    expect(screen.getByText(/roughly 2× your PostgreSQL disk/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 409 on start
  // -------------------------------------------------------------------------

  it('renders a link to the in-flight run when starting hits a 409', async () => {
    const user = userEvent.setup();
    mockStartRun.mockRejectedValue(
      new ApiError('A database backup run is already in progress', 409),
    );
    // The 409 body loses activeRunId to the exception filter, so the hook
    // refetches the config; the SECOND config read reports the active run.
    mockGetConfig
      .mockResolvedValueOnce(makeConfig())
      .mockResolvedValue(makeConfig({ activeRunId: 'run-9999-8888' }));
    mockGetRun.mockResolvedValue(
      makeRun({ id: 'run-9999-8888', status: 'running', finishedAt: null }),
    );

    render(<DbBackupPage />);
    const button = await screen.findByRole('button', { name: 'Back up now' });
    await user.click(button);

    const link = await screen.findByRole('link', { name: /View run run-9999/ });
    expect(link).toHaveAttribute('href', '#db-backup-active-run');
    // Not surfaced as a generic error.
    expect(
      screen.queryByText('A database backup run is already in progress'),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Live progress
  // -------------------------------------------------------------------------

  it('renders live byte progress and elapsed time for an active run', async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ activeRunId: 'run-live' }));
    mockGetRun.mockResolvedValue(
      makeRun({
        id: 'run-live',
        status: 'running',
        finishedAt: null,
        verifiedAt: null,
        sizeBytes: null,
        bytesWritten: '1073741824',
        elapsedMs: 2_400_000,
        lastHeartbeatAt: new Date().toISOString(),
      }),
    );

    render(<DbBackupPage />);

    await screen.findByText('Written so far');
    expect(screen.getByText('1.00 GB')).toBeInTheDocument();
    expect(screen.getByText('40m')).toBeInTheDocument();
    // The long-run reassurance, not an unexplained spinner.
    expect(
      screen.getByText(/can legitimately take tens of minutes/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
    // "Back up now" is unavailable while the slot is held.
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  });

  it('renders a distinct stale state when the heartbeat has gone quiet', async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ activeRunId: 'run-stale' }));
    mockGetRun.mockResolvedValue(
      makeRun({
        id: 'run-stale',
        status: 'running',
        finishedAt: null,
        verifiedAt: null,
        sizeBytes: null,
        bytesWritten: '104857600',
        elapsedMs: 5_400_000,
        // 90 minutes of silence against a 30-minute stale window.
        lastHeartbeatAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    );

    render(<DbBackupPage />);

    await screen.findByText('This run looks stale');
    expect(screen.getByText(/no heartbeat for more than 30 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/\(stale\)/)).toBeInTheDocument();
  });

  it('marks a run stale from its status alone', async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ activeRunId: 'run-stale-status' }));
    mockGetRun.mockResolvedValue(
      makeRun({
        id: 'run-stale-status',
        status: 'stale',
        finishedAt: null,
        verifiedAt: null,
        sizeBytes: null,
        lastHeartbeatAt: new Date().toISOString(),
      }),
    );

    render(<DbBackupPage />);
    await screen.findByText('This run looks stale');
  });

  // -------------------------------------------------------------------------
  // Row actions
  // -------------------------------------------------------------------------

  it('offers Download on a completed run and disables Restore pending #344', async () => {
    // Restore permission GRANTED — the action is still unavailable, because the
    // endpoint itself does not exist yet.
    mockUsePermissions.mockReturnValue(
      adminPermissions(['db_backup:read', 'db_backup:write', 'db_backup:restore']),
    );
    render(<DbBackupPage />);
    await screen.findByTestId('row-run-1111-2222');

    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();

    const restore = screen.getByRole('button', {
      name: 'Restore (not yet available)',
    });
    expect(restore).toBeDisabled();
  });

  it('labels Restore with the missing permission when db_backup:restore is absent', async () => {
    mockUsePermissions.mockReturnValue(adminPermissions(['db_backup:read']));
    render(<DbBackupPage />);
    await screen.findByTestId('row-run-1111-2222');

    expect(
      screen.getByRole('button', { name: 'Restore (requires db_backup:restore)' }),
    ).toBeDisabled();
    // Read-only admins cannot delete or trigger.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  });

  it('disables Download for a run that produced no archive', async () => {
    mockListRuns.mockResolvedValue(
      runsResponse([
        makeRun({
          id: 'run-failed',
          status: 'failed',
          sizeBytes: null,
          verifiedAt: null,
          lastError: 'pg_dump exited 1',
        }),
      ]),
    );
    render(<DbBackupPage />);
    await screen.findByTestId('row-run-failed');
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });
});
