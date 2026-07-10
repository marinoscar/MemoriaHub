/**
 * Unit tests for JobsPage.
 *
 * Tests: renders summary counts + stuck badge; renders rows with status chip +
 * lastError; status/type filter dropdowns; Retry shown for failed/succeeded only,
 * Delete hidden for running; bulk "Retry all failed" / "Reset stuck" call the
 * actions and show a snackbar; non-admin is redirected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useJobs', () => ({
  useJobs: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import JobsPage from '../../pages/Admin/JobsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobs } from '../../hooks/useJobs';
import type { UseJobsResult } from '../../hooks/useJobs';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseJobs = vi.mocked(useJobs);

// ---------------------------------------------------------------------------
// Default mock factories
// ---------------------------------------------------------------------------

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

function makeJobsHook(overrides: Partial<UseJobsResult> = {}): UseJobsResult {
  return {
    stats: {
      total: 10,
      byStatus: { pending: 4, running: 1, succeeded: 4, failed: 1 },
      byType: [{ type: 'face_detection', pending: 4, running: 1, succeeded: 4, failed: 1, total: 10 }],
      stuckRunning: 0,
      scheduled: 0,
      stuckThresholdMinutes: 3,
    },
    jobs: [],
    meta: null,
    statsLoading: false,
    jobsLoading: false,
    statsError: null,
    jobsError: null,
    mutating: false,
    filters: { page: 1, pageSize: 20 },
    setFilters: vi.fn(),
    autoRefresh: true,
    setAutoRefresh: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    retryJob: vi.fn().mockResolvedValue(undefined),
    retryAllFailed: vi.fn().mockResolvedValue({ retried: 3 }),
    resetStuck: vi.fn().mockResolvedValue({ reset: 2 }),
    repairThumbnails: vi.fn().mockResolvedValue({ jobId: 'repair-job-uuid', status: 'pending' }),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-uuid-1',
    type: 'face_detection',
    status: 'pending' as const,
    reason: 'upload',
    priority: 0,
    mediaItemId: 'media-uuid-1-abcdef',
    circleId: 'circle-uuid-1',
    attempts: 2,
    lastError: null as string | null,
    providerKey: null as string | null,
    modelVersion: null as string | null,
    createdAt: '2024-01-15T10:00:00Z',
    startedAt: null as string | null,
    finishedAt: null as string | null,
    scheduledFor: null as string | null,
    rateLimitedAt: null as string | null,
    rateLimitHits: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('JobsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseJobs.mockReturnValue(makeJobsHook());
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  describe('Authorization', () => {
    it('redirects non-admin users — page content not shown', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The page heading should not appear
      expect(screen.queryByText(/job queue/i)).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /job queue/i })).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Summary counts / stats
  // =========================================================================

  describe('Summary counts', () => {
    it('renders total, pending, running, succeeded, and failed chip counts', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/total: 10/i)).toBeInTheDocument();
        expect(screen.getByText(/pending: 4/i)).toBeInTheDocument();
        expect(screen.getByText(/running: 1/i)).toBeInTheDocument();
        expect(screen.getByText(/succeeded: 4/i)).toBeInTheDocument();
        expect(screen.getByText(/failed: 1/i)).toBeInTheDocument();
      });
    });

    it('renders the stuck badge when stuckRunning > 0', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          stats: {
            total: 5,
            byStatus: { pending: 0, running: 5, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 3,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/3 stuck/i)).toBeInTheDocument();
      });
    });

    it('does not render the stuck badge when stuckRunning is 0', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/total: 10/i)).toBeInTheDocument();
      });

      // The "Stuck running" chip in the summary panel only appears when stuckRunning > 0.
      // (The "Reset stuck" button always shows but has a different label.)
      expect(screen.queryByText(/stuck running/i)).not.toBeInTheDocument();
    });

    it('renders per-type chips in the stats panel', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/face_detection: 10/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Jobs table — row rendering
  // =========================================================================

  describe('Jobs table', () => {
    it('renders a row for each job with type, status chip', async () => {
      const jobs = [
        makeJob({ id: 'job-1', type: 'face_detection', status: 'failed' }),
        makeJob({ id: 'job-2', type: 'ocr', status: 'succeeded' }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
        expect(screen.getByText('ocr')).toBeInTheDocument();
      });

      // Status chips
      expect(screen.getByText('failed')).toBeInTheDocument();
      expect(screen.getByText('succeeded')).toBeInTheDocument();
    });

    it('renders lastError text when a job has one', async () => {
      const jobs = [makeJob({ status: 'failed', lastError: 'Timeout after 30s' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Timeout after 30s')).toBeInTheDocument();
      });
    });

    it('shows "No jobs found" when jobs list is empty', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [] }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/no jobs found/i)).toBeInTheDocument();
      });
    });

    it('renders "Global" in the Media Item cell for jobs with null mediaItemId (system jobs)', async () => {
      const jobs = [makeJob({ id: 'job-global-1', type: 'storage_insights', mediaItemId: null, circleId: null })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Global')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Action button visibility rules
  // =========================================================================

  describe('Action button visibility', () => {
    // Each row now shows a single kebab IconButton (aria-label="Job actions") that
    // opens a MUI Menu with three MenuItems: "Download JSON", "Re-run", "Delete".
    // "Re-run" is enabled only for failed/succeeded; "Delete" is disabled for running.
    // Disabled MUI MenuItems render with aria-disabled="true".

    it('Re-run menu item is enabled for failed jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0, scheduled: 0, stuckThresholdMinutes: 3 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      expect(rerunItem).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('Re-run menu item is enabled for succeeded jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'succeeded' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      expect(rerunItem).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('Re-run menu item is disabled for pending jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      expect(rerunItem).toHaveAttribute('aria-disabled', 'true');
    });

    it('Re-run menu item is disabled for running jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'running' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      expect(rerunItem).toHaveAttribute('aria-disabled', 'true');
    });

    it('Delete menu item is enabled for pending jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      expect(deleteItem).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('Delete menu item is disabled for running jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'running' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    });

    it('Re-run and Delete menu items are both enabled for failed jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0, scheduled: 0, stuckThresholdMinutes: 3 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      expect(rerunItem).not.toHaveAttribute('aria-disabled', 'true');
      expect(deleteItem).not.toHaveAttribute('aria-disabled', 'true');
    });
  });

  // =========================================================================
  // Bulk actions
  // =========================================================================

  describe('Bulk actions', () => {
    it('calls retryAllFailed action when "Retry all failed" button is clicked', async () => {
      const retryAllFailed = vi.fn().mockResolvedValue({ retried: 2 });
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          retryAllFailed,
          stats: {
            total: 5,
            byStatus: { pending: 3, running: 0, succeeded: 1, failed: 1 },
            byType: [],
            stuckRunning: 0,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const retryBtn = await screen.findByRole('button', { name: /retry all failed/i });
      await user.click(retryBtn);

      expect(retryAllFailed).toHaveBeenCalled();
    });

    it('shows success snackbar after retryAllFailed', async () => {
      const retryAllFailed = vi.fn().mockResolvedValue({ retried: 3 });
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          retryAllFailed,
          stats: {
            total: 5,
            byStatus: { pending: 2, running: 0, succeeded: 0, failed: 3 },
            byType: [],
            stuckRunning: 0,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const retryBtn = await screen.findByRole('button', { name: /retry all failed/i });
      await user.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByText(/3 job\(s\) reset to pending/i)).toBeInTheDocument();
      });
    });

    it('calls resetStuck action when "Reset stuck" button is clicked', async () => {
      const resetStuck = vi.fn().mockResolvedValue({ reset: 1 });
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          resetStuck,
          stats: {
            total: 5,
            byStatus: { pending: 0, running: 5, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 5,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const resetBtn = await screen.findByRole('button', { name: /reset stuck/i });
      await user.click(resetBtn);

      // handleResetStuck calls the hook's resetStuck() with no argument — the
      // service resolves the jobs.stuckThresholdMinutes system setting itself.
      expect(resetStuck).toHaveBeenCalledWith();
    });

    it('shows success snackbar after resetStuck', async () => {
      const resetStuck = vi.fn().mockResolvedValue({ reset: 2 });
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          resetStuck,
          stats: {
            total: 5,
            byStatus: { pending: 0, running: 5, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 5,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const resetBtn = await screen.findByRole('button', { name: /reset stuck/i });
      await user.click(resetBtn);

      await waitFor(() => {
        expect(screen.getByText(/2 stuck job\(s\) reset to pending/i)).toBeInTheDocument();
      });
    });

    it('"Retry all failed" button is disabled when failed count is 0', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          stats: {
            total: 5,
            byStatus: { pending: 5, running: 0, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 0,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /retry all failed/i });
        expect(btn).toBeDisabled();
      });
    });

    it('"Reset stuck" button is disabled when stuckRunning is 0', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          stats: {
            total: 5,
            byStatus: { pending: 5, running: 0, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 0,
            scheduled: 0,
            stuckThresholdMinutes: 3,
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /reset stuck/i });
        expect(btn).toBeDisabled();
      });
    });

    it('calls repairThumbnails action when "Repair missing thumbnails" button is clicked', async () => {
      const repairThumbnails = vi.fn().mockResolvedValue({ jobId: 'repair-uuid', status: 'pending' });
      mockUseJobs.mockReturnValue(makeJobsHook({ repairThumbnails }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const repairBtn = await screen.findByRole('button', { name: /repair missing thumbnails/i });
      await user.click(repairBtn);

      expect(repairThumbnails).toHaveBeenCalled();
    });

    it('shows success snackbar with the jobId after repairThumbnails', async () => {
      const repairThumbnails = vi
        .fn()
        .mockResolvedValue({ jobId: 'abcd1234-ffff', status: 'pending' });
      mockUseJobs.mockReturnValue(makeJobsHook({ repairThumbnails }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const repairBtn = await screen.findByRole('button', { name: /repair missing thumbnails/i });
      await user.click(repairBtn);

      await waitFor(() => {
        // Snackbar message includes shortId(jobId) = first 8 chars
        expect(screen.getByText(/thumbnail repair queued \(job abcd1234…\)/i)).toBeInTheDocument();
      });
    });

    it('shows error snackbar when repairThumbnails fails', async () => {
      const repairThumbnails = vi.fn().mockRejectedValue(new Error('Repair boom'));
      mockUseJobs.mockReturnValue(makeJobsHook({ repairThumbnails }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const repairBtn = await screen.findByRole('button', { name: /repair missing thumbnails/i });
      await user.click(repairBtn);

      await waitFor(() => {
        expect(screen.getByText(/repair boom/i)).toBeInTheDocument();
      });
    });

    it('renders the configured stuckThresholdMinutes in the "Reset stuck" button label', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          stats: {
            total: 5,
            byStatus: { pending: 0, running: 5, succeeded: 0, failed: 0 },
            byType: [],
            stuckRunning: 5,
            scheduled: 0,
            stuckThresholdMinutes: 45,
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset stuck \(>45 min\)/i })).toBeInTheDocument();
      });
    });

    it('falls back to a "3 min" label when stats is null', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ stats: null }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset stuck \(>3 min\)/i })).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Per-row retry action
  // =========================================================================

  describe('Per-row retry', () => {
    it('calls retryJob with the job id when Re-run menu item is clicked', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-abc', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          retryJob,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0, scheduled: 0, stuckThresholdMinutes: 3 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Open the kebab menu and click the Re-run menu item.
      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      await user.click(rerunItem);

      expect(retryJob).toHaveBeenCalledWith('job-abc');
    });

    it('shows success snackbar after per-row retry', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-abc-1234', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          retryJob,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0, scheduled: 0, stuckThresholdMinutes: 3 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const rerunItem = await screen.findByRole('menuitem', { name: /re-run/i });
      await user.click(rerunItem);

      await waitFor(() => {
        // The snackbar message includes shortId(job.id)... = first 8 chars
        expect(screen.getByText(/job-abc-…/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Delete flow
  // =========================================================================

  describe('Delete flow', () => {
    it('shows confirm dialog when Delete menu item is clicked', async () => {
      const jobs = [makeJob({ id: 'job-del-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Open the kebab menu and click Delete
      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      await user.click(deleteItem);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/delete job\?/i)).toBeInTheDocument();
      });
    });

    it('cancels delete when Cancel is clicked in dialog', async () => {
      const deleteJob = vi.fn();
      const jobs = [makeJob({ id: 'job-del-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs, deleteJob }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      await user.click(deleteItem);

      const cancelBtn = await screen.findByRole('button', { name: /cancel/i });
      await user.click(cancelBtn);

      expect(deleteJob).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('calls deleteJob with the correct id when confirmed', async () => {
      const deleteJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-del-abc', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs, deleteJob }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      await user.click(deleteItem);

      const confirmBtn = await screen.findByRole('button', { name: /^delete$/i });
      await user.click(confirmBtn);

      expect(deleteJob).toHaveBeenCalledWith('job-del-abc');
    });

    it('shows success snackbar after delete is confirmed', async () => {
      const deleteJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-del-1234abcd', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs, deleteJob }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
      await user.click(deleteItem);

      const confirmBtn = await screen.findByRole('button', { name: /^delete$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/deleted/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Download JSON
  // =========================================================================

  describe('Download JSON', () => {
    it('menu contains a Download JSON item that is not disabled', async () => {
      const jobs = [makeJob({ id: 'job-dl-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const downloadItem = screen.getByRole('menuitem', { name: /download json/i });
      expect(downloadItem).toBeInTheDocument();
      expect(downloadItem).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('clicking Download JSON triggers a file download', async () => {
      const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock');
      const mockRevokeObjectURL = vi.fn();
      Object.defineProperty(global.URL, 'createObjectURL', { value: mockCreateObjectURL, writable: true });
      Object.defineProperty(global.URL, 'revokeObjectURL', { value: mockRevokeObjectURL, writable: true });

      const mockClick = vi.fn();
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === 'a') {
          vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(mockClick);
        }
        return el;
      });

      const jobs = [makeJob({ id: 'job-dl-2', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const kebab = await screen.findByRole('button', { name: /job actions/i });
      await user.click(kebab);

      const downloadItem = await screen.findByRole('menuitem', { name: /download json/i });
      await user.click(downloadItem);

      expect(mockCreateObjectURL).toHaveBeenCalled();
      expect(mockClick).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  // =========================================================================
  // Model column
  // =========================================================================

  describe('Model column', () => {
    it('renders modelVersion and providerKey when both are set', async () => {
      const jobs = [
        makeJob({
          id: 'job-1',
          modelVersion: 'claude-3-haiku-20240307',
          providerKey: 'anthropic',
        }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('claude-3-haiku-20240307')).toBeInTheDocument();
        expect(screen.getByText('anthropic')).toBeInTheDocument();
      });
    });

    it('renders only modelVersion when providerKey is null', async () => {
      const jobs = [
        makeJob({
          id: 'job-1',
          modelVersion: 'mobilenet-v2',
          providerKey: null,
        }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('mobilenet-v2')).toBeInTheDocument();
      });
    });

    it('renders an em dash when both modelVersion and providerKey are null', async () => {
      const jobs = [
        makeJob({
          id: 'job-1',
          modelVersion: null,
          providerKey: null,
        }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
      });

      // The muted em dash placeholder — may appear in multiple cells (e.g. lastError, Model).
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Error states
  // =========================================================================

  describe('Error states', () => {
    it('renders statsError alert when stats fetch fails', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ stats: null, statsError: 'Stats load failed' }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/stats load failed/i)).toBeInTheDocument();
      });
    });

    it('renders jobsError alert when jobs fetch fails', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobsError: 'Jobs load failed' }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/jobs load failed/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Scheduled (backing off) stats chip
  // =========================================================================

  describe('Scheduled (backing off) stat chip', () => {
    it('renders the "Scheduled (backing off)" chip when scheduled > 0', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          stats: {
            total: 5,
            byStatus: { pending: 3, running: 0, succeeded: 2, failed: 0 },
            byType: [],
            stuckRunning: 0,
            scheduled: 2,
            stuckThresholdMinutes: 3,
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/scheduled \(backing off\): 2/i)).toBeInTheDocument();
      });
    });

    it('does not render the "Scheduled (backing off)" chip when scheduled is 0', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/total: 10/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/scheduled \(backing off\)/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Per-row backoff badge
  // =========================================================================

  describe('Per-row backoff badge', () => {
    it('shows "backing off" chip for a pending job with a future scheduledFor', async () => {
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      const jobs = [makeJob({ status: 'pending', scheduledFor: futureIso, rateLimitHits: 1 })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The per-row status Chip label is exactly "backing off" (lowercase),
      // while the "Backing off" filter toggle label always renders in the
      // filters bar above the table — match the exact lowercase chip text so
      // the two elements don't collide.
      await waitFor(() => {
        expect(screen.getByText('backing off')).toBeInTheDocument();
      });
    });

    it('does not show the backoff chip for a pending job with null scheduledFor', async () => {
      const jobs = [makeJob({ status: 'pending', scheduledFor: null, rateLimitHits: 0 })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
      });

      // Exact lowercase match targets only the per-row Chip — the "Backing
      // off" filter toggle label (capitalized) always renders regardless.
      expect(screen.queryByText('backing off')).not.toBeInTheDocument();
    });

    it('does not show the backoff chip for a failed job even if scheduledFor is set', async () => {
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      const jobs = [makeJob({ status: 'failed', scheduledFor: futureIso, rateLimitHits: 2 })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
      });

      // Exact lowercase match targets only the per-row Chip — the "Backing
      // off" filter toggle label (capitalized) always renders regardless.
      expect(screen.queryByText('backing off')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scheduled filter toggle
  // =========================================================================

  describe('Scheduled filter toggle', () => {
    it('renders the "Backing off" toggle in the filters area', async () => {
      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/backing off/i)).toBeInTheDocument();
      });
    });

    it('calls setFilters with scheduled=true when the backing-off toggle is enabled', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // MUI's Switch input renders with role="switch" (not the native
      // "checkbox" role) since the current MUI version. Its accessible name
      // comes from the wrapping Tooltip's `title` text ("Show only pending
      // jobs currently waiting on backoff…"), not the visible "Backing off"
      // label, so match on a substring of the tooltip text instead.
      const toggle = await screen.findByRole('switch', { name: /waiting on backoff/i });
      await user.click(toggle);

      expect(setFilters).toHaveBeenCalledWith(
        expect.objectContaining({ scheduled: true }),
      );
    });

    it('calls setFilters without scheduled when the backing-off toggle is disabled again', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Enable then disable
      // MUI's Switch input renders with role="switch" (not the native
      // "checkbox" role) since the current MUI version. Its accessible name
      // comes from the wrapping Tooltip's `title` text ("Show only pending
      // jobs currently waiting on backoff…"), not the visible "Backing off"
      // label, so match on a substring of the tooltip text instead.
      const toggle = await screen.findByRole('switch', { name: /waiting on backoff/i });
      await user.click(toggle); // on
      await user.click(toggle); // off

      // Second call should not include scheduled (or pass undefined/falsy)
      const secondCall = setFilters.mock.calls[1]?.[0] ?? {};
      expect(secondCall.scheduled).toBeFalsy();
    });
  });
});
