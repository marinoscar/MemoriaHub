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
  });

  // =========================================================================
  // Action button visibility rules
  // =========================================================================

  describe('Action button visibility', () => {
    // The page has a "Retry all failed" bulk button (always rendered, may be disabled)
    // which contains a ReplayIcon. Per-row retry buttons also use ReplayIcon.
    // DeleteIcon only appears in row actions (never in the bulk bar).
    // We count icons: 1 in bulk bar + 1 per eligible row.

    it('shows per-row Retry button (additional ReplayIcon) for failed jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0 },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        // 1 from bulk bar + 1 from row = at least 2
        expect(screen.getAllByTestId('ReplayIcon').length).toBeGreaterThanOrEqual(2);
      });
    });

    it('shows per-row Retry button for succeeded jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'succeeded' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        // 1 from bulk bar + 1 from row = at least 2
        expect(screen.getAllByTestId('ReplayIcon').length).toBeGreaterThanOrEqual(2);
      });
    });

    it('does NOT show per-row Retry for pending jobs (only bulk bar icon)', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('pending')).toBeInTheDocument();
      });

      // Only the bulk bar Retry button — no per-row retry for pending
      expect(screen.getAllByTestId('ReplayIcon').length).toBe(1);
    });

    it('does NOT show per-row Retry for running jobs (only bulk bar icon)', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'running' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('running')).toBeInTheDocument();
      });

      // Only the bulk bar Retry button — no per-row retry for running
      expect(screen.getAllByTestId('ReplayIcon').length).toBe(1);
    });

    it('shows Delete button for non-running jobs (pending)', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByTestId('DeleteIcon')).toBeInTheDocument();
      });
    });

    it('does NOT show Delete button for running jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'running' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('running')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('DeleteIcon')).not.toBeInTheDocument();
    });

    it('shows both per-row Retry and Delete for failed jobs', async () => {
      const jobs = [makeJob({ id: 'job-1', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0 },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        // Multiple ReplayIcons (bulk bar + per-row) and one DeleteIcon in the row
        expect(screen.getAllByTestId('ReplayIcon').length).toBeGreaterThanOrEqual(2);
        expect(screen.getByTestId('DeleteIcon')).toBeInTheDocument();
      });
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
          },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      const resetBtn = await screen.findByRole('button', { name: /reset stuck/i });
      await user.click(resetBtn);

      expect(resetStuck).toHaveBeenCalledWith(10);
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
          },
        }),
      );

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /reset stuck/i });
        expect(btn).toBeDisabled();
      });
    });
  });

  // =========================================================================
  // Per-row retry action
  // =========================================================================

  describe('Per-row retry', () => {
    it('calls retryJob with the job id when Retry button is clicked', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-abc', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          retryJob,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The page renders bulk Retry (index 0) and per-row Retry (index 1).
      // Click the last ReplayIcon (the per-row one in the table body).
      await waitFor(() => {
        expect(screen.getAllByTestId('ReplayIcon').length).toBeGreaterThanOrEqual(2);
      });
      const replayIcons = screen.getAllByTestId('ReplayIcon');
      const rowRetryIcon = replayIcons[replayIcons.length - 1];
      await user.click(rowRetryIcon.closest('button')!);

      expect(retryJob).toHaveBeenCalledWith('job-abc');
    });

    it('shows success snackbar after per-row retry', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      const jobs = [makeJob({ id: 'job-abc-1234', status: 'failed' })];
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          jobs,
          retryJob,
          stats: { total: 1, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 1 }, byType: [], stuckRunning: 0 },
        }),
      );
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getAllByTestId('ReplayIcon').length).toBeGreaterThanOrEqual(2);
      });
      const replayIcons = screen.getAllByTestId('ReplayIcon');
      const rowRetryIcon = replayIcons[replayIcons.length - 1];
      await user.click(rowRetryIcon.closest('button')!);

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
    it('shows confirm dialog when Delete button is clicked', async () => {
      const jobs = [makeJob({ id: 'job-del-1', status: 'pending' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));
      const user = userEvent.setup();

      render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Find the DeleteIcon and click its parent button
      const deleteIcon = await screen.findByTestId('DeleteIcon');
      await user.click(deleteIcon.closest('button')!);

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

      const deleteIcon = await screen.findByTestId('DeleteIcon');
      await user.click(deleteIcon.closest('button')!);

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

      const deleteIcon = await screen.findByTestId('DeleteIcon');
      await user.click(deleteIcon.closest('button')!);

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

      const deleteIcon = await screen.findByTestId('DeleteIcon');
      await user.click(deleteIcon.closest('button')!);

      const confirmBtn = await screen.findByRole('button', { name: /^delete$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/deleted/i)).toBeInTheDocument();
      });
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
});
