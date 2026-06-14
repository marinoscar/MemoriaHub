import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

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

describe('BackupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: admin user
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseBackup.mockReturnValue(makeBackup());
    mockUseCircles.mockReturnValue(makeCircles());
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
});
