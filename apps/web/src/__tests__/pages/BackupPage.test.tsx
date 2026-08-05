/**
 * BackupPage tests — the run-history table was migrated onto the shared
 * DataTable in issue #259. Per docs/specs/datatable.md §18.5 this file covers
 * the page's own column declarations (`./backupTable.tsx`) and its behaviour;
 * table mechanics belong to `runDataTableConformanceSuite`.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

// Mock hooks before importing them
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useBackup', () => ({
  useBackup: vi.fn(),
}));

vi.mock('../../hooks/useCircles', () => ({
  useCircles: vi.fn(),
}));

import { usePermissions } from '../../hooks/usePermissions';
import { useBackup } from '../../hooks/useBackup';
import { useCircles } from '../../hooks/useCircles';
import BackupPage from '../../pages/Admin/BackupPage';
import { BACKUP_RUN_COLUMNS, backupRunStatus } from '../../pages/Admin/backupTable';
import { api } from '../../services/api';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseBackup = vi.mocked(useBackup);
const mockUseCircles = vi.mocked(useCircles);

function makePermissions(isAdmin: boolean) {
  return {
    permissions: new Set<string>(),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(isAdmin),
    hasAnyPermission: vi.fn().mockReturnValue(isAdmin),
    hasAllPermissions: vi.fn().mockReturnValue(isAdmin),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  };
}

function makeBackup(overrides: Partial<ReturnType<typeof useBackup>> = {}): ReturnType<typeof useBackup> {
  return {
    runs: [],
    runsLoading: false,
    runsError: null,
    running: false,
    runResult: null,
    runError: null,
    triggerBackup: vi.fn().mockResolvedValue({ runId: 'r1', scope: 'all', copied: 0, skipped: 0, failed: 0, errors: [] }),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCircles(overrides: Partial<ReturnType<typeof useCircles>> = {}): ReturnType<typeof useCircles> {
  return {
    circles: [],
    loading: false,
    error: null,
    fetchCircles: vi.fn().mockResolvedValue(undefined),
    addCircle: vi.fn(),
    editCircle: vi.fn(),
    removeCircle: vi.fn(),
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    scope: 'all',
    copied: 3,
    skipped: 0,
    failed: 0,
    errors: [] as string[],
    startedAt: new Date('2024-01-15T10:00:00Z').toISOString(),
    completedAt: new Date('2024-01-15T10:01:00Z').toISOString(),
    ...overrides,
  };
}

describe('BackupPage', () => {
  beforeAll(() => {
    // jsdom performs no layout — the shared stub recipe is what makes MUI X
    // render rows at all (docs/specs/datatable.md §12).
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // Default: admin user
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseBackup.mockReturnValue(makeBackup());
    mockUseCircles.mockReturnValue(makeCircles());
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  describe('Column definitions', () => {
    it('leads the card with Scope then Status (issue #259: status is primary)', () => {
      const primaries = BACKUP_RUN_COLUMNS.filter((c) => c.priority === 'primary').map((c) => c.id);
      expect(primaries).toEqual(['scope', 'status']);
    });

    it('derives a run status the endpoint does not return', () => {
      expect(backupRunStatus(makeRun() as never)).toBe('Succeeded');
      expect(backupRunStatus(makeRun({ failed: 2 }) as never)).toBe('Failed');
      expect(backupRunStatus(makeRun({ completedAt: undefined }) as never)).toBe('Running');
      // A failure outranks "still running".
      expect(backupRunStatus(makeRun({ failed: 1, completedAt: undefined }) as never)).toBe('Failed');
    });
  });

  describe('Authorization', () => {
    it('redirects non-admin to /', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText(/admin backup/i)).not.toBeInTheDocument();
    });

    it('renders for admin user', async () => {
      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/admin backup/i)).toBeInTheDocument();
      });
    });
  });

  describe('Scope selector', () => {
    it('shows scope dropdown with All circles option', async () => {
      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/admin backup/i)).toBeInTheDocument();
      });

      // The Select renders with a combobox role
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      // The default value is 'all' which maps to "All circles"
      expect(screen.getByText('All circles')).toBeInTheDocument();
    });

    it('populates circles in dropdown', async () => {
      const user = userEvent.setup();

      mockUseCircles.mockReturnValue(
        makeCircles({
          circles: [
            {
              id: 'circle-a',
              name: 'Alpha Circle',
              description: null,
              ownerId: 'owner-1',
              isPersonal: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'circle-b',
              name: 'Beta Circle',
              description: null,
              ownerId: 'owner-1',
              isPersonal: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      // Open the dropdown to see all options
      await user.click(screen.getByRole('combobox'));

      await waitFor(() => {
        expect(screen.getByText('Alpha Circle')).toBeInTheDocument();
        expect(screen.getByText('Beta Circle')).toBeInTheDocument();
      });
    });
  });

  describe('Run Backup button', () => {
    it('shows Run Backup button for admin', async () => {
      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run backup/i })).toBeInTheDocument();
      });
    });

    it('disables button while backup is running', async () => {
      mockUseBackup.mockReturnValue(makeBackup({ running: true }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        // When running is true the button text changes to "Running..."
        const button = screen.getByRole('button', { name: /running/i });
        expect(button).toBeDisabled();
      });
    });

    it('calls triggerBackup on button click', async () => {
      const user = userEvent.setup();
      const mockTriggerBackup = vi.fn().mockResolvedValue({
        runId: 'r1',
        scope: 'all',
        copied: 5,
        skipped: 0,
        failed: 0,
        errors: [],
      });

      mockUseBackup.mockReturnValue(makeBackup({ triggerBackup: mockTriggerBackup }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run backup/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /run backup/i }));

      await waitFor(() => {
        expect(mockTriggerBackup).toHaveBeenCalled();
      });
    });
  });

  describe('Result display', () => {
    it('shows success result after backup completes', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({
          runResult: {
            runId: 'r1',
            scope: 'all',
            copied: 5,
            skipped: 1,
            failed: 0,
            errors: [],
          },
        }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/backup completed/i)).toBeInTheDocument();
        expect(screen.getByText(/5/)).toBeInTheDocument();
      });
    });

    it('shows error alert when backup fails', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({ runError: 'Connection failed' }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
      });
    });

    it('shows errors list when backup has partial errors', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({
          runResult: {
            runId: 'r2',
            scope: 'all',
            copied: 3,
            skipped: 0,
            failed: 2,
            errors: ['file not found', 'permission denied'],
          },
        }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('file not found')).toBeInTheDocument();
        expect(screen.getByText('permission denied')).toBeInTheDocument();
      });
    });
  });

  describe('Recent runs table', () => {
    it('shows loading state for runs', async () => {
      mockUseBackup.mockReturnValue(makeBackup({ runsLoading: true }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toBeInTheDocument();
      });
    });

    it('shows empty state when no runs', async () => {
      mockUseBackup.mockReturnValue(makeBackup({ runs: [] }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/no backup runs found/i)).toBeInTheDocument();
      });
    });

    it('renders runs in table', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({
          runs: [
            {
              runId: 'run-1',
              scope: 'all',
              copied: 3,
              skipped: 0,
              failed: 0,
              errors: [],
              startedAt: new Date('2024-01-15T10:00:00Z').toISOString(),
              completedAt: new Date('2024-01-15T10:01:00Z').toISOString(),
            },
          ],
        }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('all')).toBeInTheDocument();
        // The copied count of 3
        expect(screen.getByText('3')).toBeInTheDocument();
      });
    });

    it('shows error chip for failed count > 0', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({
          runs: [
            {
              runId: 'run-2',
              scope: 'all',
              copied: 1,
              skipped: 0,
              failed: 2,
              errors: [],
              startedAt: new Date('2024-01-15T10:00:00Z').toISOString(),
              completedAt: undefined,
            },
          ],
        }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        // The failed count chip shows "2"
        const chips = screen.getAllByText('2');
        expect(chips.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Run status column (rendered)', () => {
    it('shows a Succeeded chip for a clean completed run', async () => {
      mockUseBackup.mockReturnValue(makeBackup({ runs: [makeRun()] as never }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      const grid = await screen.findByRole('grid', { name: /backup runs/i });
      await waitFor(() => {
        expect(within(grid).getByText('Succeeded')).toBeInTheDocument();
      });
    });

    it('shows a Failed chip when the run had failures', async () => {
      mockUseBackup.mockReturnValue(
        makeBackup({ runs: [makeRun({ runId: 'run-2', failed: 2, completedAt: undefined })] as never }),
      );

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      const grid = await screen.findByRole('grid', { name: /backup runs/i });
      await waitFor(() => {
        // Both the derived status chip and the Failed column header read
        // "Failed"; the chip is the one inside a row.
        const cells = within(grid).getAllByRole('gridcell');
        expect(cells.some((cell) => cell.textContent === 'Failed')).toBe(true);
      });
    });
  });

  describe('Phone layout (360px)', () => {
    it('renders cards and contains its own width', async () => {
      setInitialContainerWidth(360);
      mockUseBackup.mockReturnValue(makeBackup({ runs: [makeRun()] as never }));

      render(<BackupPage />, { wrapperOptions: { user: mockAdminUser } });

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});
