/**
 * Unit tests for JobsPage — post-#258 (the shared-DataTable pilot migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8: TABLE MECHANICS are a property
 * of the component, not of this page's column declarations, and are covered
 * end-to-end by `runDataTableConformanceSuite` (pagination/sort/selection
 * round-trips, the negative "never filters rows locally" test, loading/empty/
 * error overlays, column visibility + density, CSV escaping, the issue #243
 * invisible-but-tappable sweep, axe in both renderers and both themes, the
 * 360px no-horizontal-scroll guard). None of that is re-tested here.
 *
 * What IS here is everything the migration could plausibly break:
 *   - the auto-refresh poll not disturbing selection / filters / expansion,
 *   - each filter's mapping onto this endpoint's params (especially
 *     `processedWithin` and `scheduled`, which are not plain column filters),
 *   - the per-row and queue-wide mutations,
 *   - permission gating.
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
import { normalizeJobFilters, toJobQuery } from '../../pages/Admin/jobsTable';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobs } from '../../hooks/useJobs';
import type { UseJobsResult } from '../../hooks/useJobs';
import type { DataTableFilterModel } from '../../components/datatable';
import { api } from '../../services/api';

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

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    total: 10,
    byStatus: { pending: 4, running: 1, succeeded: 4, failed: 1 },
    byType: [
      { type: 'face_detection', pending: 4, running: 1, succeeded: 4, failed: 1, total: 10 },
      { type: 'auto_tagging', pending: 0, running: 0, succeeded: 0, failed: 0, total: 0 },
    ],
    stuckRunning: 0,
    scheduled: 0,
    stuckThresholdMinutes: 3,
    ...overrides,
  } as UseJobsResult['stats'];
}

function makeJobsHook(overrides: Partial<UseJobsResult> = {}): UseJobsResult {
  return {
    stats: makeStats(),
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

/** Render the page for an admin, with the router/theme wrapper the app uses. */
function renderPage() {
  return render(<JobsPage />, { wrapperOptions: { user: mockAdminUser } });
}

// ---------------------------------------------------------------------------
// MUI select driving (the filter editor's three controls)
// ---------------------------------------------------------------------------

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  selectName: string | RegExp,
  optionName: string | RegExp,
) {
  const combo = await screen.findByRole('combobox', { name: selectName });
  await user.click(combo);
  const option = await screen.findByRole('option', { name: optionName });
  await user.click(option);
}

/** Add one filter through the desktop filter row: column, value, Add. */
async function addFilter(
  user: ReturnType<typeof userEvent.setup>,
  columnLabel: string | RegExp,
  valueLabel: string | RegExp,
) {
  await pickOption(user, 'Column', columnLabel);
  await pickOption(user, 'Value', valueLabel);
  await user.click(screen.getByTestId('datatable-filter-apply'));
}

// ---------------------------------------------------------------------------

describe('JobsPage', () => {
  beforeAll(() => {
    // jsdom performs no layout, so MUI X measures a 0×0 viewport and renders
    // zero rows without these. Same recipe every DataTable suite uses.
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseJobs.mockReturnValue(makeJobsHook());
    // The table's layout-persistence hook reads/writes `/user-settings`
    // (docs/specs/datatable.md §15). Stub the real `api` singleton so the page
    // goes through exactly the client it ships with, without a network call.
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  describe('Authorization', () => {
    it('redirects non-admin users — page content not shown', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      renderPage();

      expect(screen.queryByText(/job queue/i)).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /job queue/i })).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Stats strip (preserved verbatim by the migration)
  // =========================================================================

  describe('Summary counts', () => {
    it('renders total, pending, running, succeeded, and failed chip counts', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/total: 10/i)).toBeInTheDocument();
        expect(screen.getByText(/pending: 4/i)).toBeInTheDocument();
        expect(screen.getByText(/running: 1/i)).toBeInTheDocument();
        expect(screen.getByText(/succeeded: 4/i)).toBeInTheDocument();
        expect(screen.getByText(/failed: 1/i)).toBeInTheDocument();
      });
    });

    it('renders the stuck badge when stuckRunning > 0', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ stats: makeStats({ stuckRunning: 3 }) }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/3 stuck/i)).toBeInTheDocument();
      });
    });

    it('does not render the stuck badge when stuckRunning is 0', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/total: 10/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/stuck running/i)).not.toBeInTheDocument();
    });

    it('renders per-type chips in the stats panel', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/face_detection: 10/i)).toBeInTheDocument();
      });
    });

    it('renders the "Scheduled (backing off)" chip when scheduled > 0', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ stats: makeStats({ scheduled: 2 }) }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/scheduled \(backing off\): 2/i)).toBeInTheDocument();
      });
    });

    it('links to the Job Insights page', async () => {
      renderPage();

      const link = await screen.findByRole('link', { name: /view insights & eta/i });
      expect(link).toHaveAttribute('href', '/admin/settings/jobs/insights');
    });
  });

  // =========================================================================
  // Table rendering
  // =========================================================================

  describe('Jobs table', () => {
    it('renders a row per job with its type and status chip', async () => {
      const jobs = [
        makeJob({ id: 'job-1', type: 'face_detection', status: 'failed' }),
        makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded' }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      const grid = await screen.findByRole('grid', { name: /enrichment jobs/i });
      await waitFor(() => {
        expect(within(grid).getByText('face_detection')).toBeInTheDocument();
        expect(within(grid).getByText('auto_tagging')).toBeInTheDocument();
        expect(within(grid).getByText('failed')).toBeInTheDocument();
        expect(within(grid).getByText('succeeded')).toBeInTheDocument();
      });
    });

    it('renders lastError text when a job has one', async () => {
      const jobs = [makeJob({ status: 'failed', lastError: 'Timeout after 30s' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Timeout after 30s')).toBeInTheDocument();
      });
    });

    it('shows "No jobs found" when the jobs list is empty', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [] }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no jobs found/i)).toBeInTheDocument();
      });
    });

    it('renders "Global" in the Media item cell for system jobs (null mediaItemId)', async () => {
      const jobs = [
        makeJob({ id: 'job-global-1', type: 'storage_insights', mediaItemId: null, circleId: null }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Global')).toBeInTheDocument();
      });
    });

    it('renders modelVersion and providerKey together', async () => {
      const jobs = [
        makeJob({ modelVersion: 'claude-3-haiku-20240307', providerKey: 'anthropic' }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('claude-3-haiku-20240307')).toBeInTheDocument();
        expect(screen.getByText('anthropic')).toBeInTheDocument();
      });
    });

    it('renders the jobs error through the table rather than blanking it', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-1' })], jobsError: 'Jobs load failed' }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/jobs load failed/i)).toBeInTheDocument();
      });
      // The stale page stays readable beneath the error (§5, `error` prop).
      expect(screen.getByText('face_detection')).toBeInTheDocument();
    });

    it('renders the stats error alert', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ stats: null, statsError: 'Stats load failed' }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/stats load failed/i)).toBeInTheDocument();
      });
    });

    it('shows the per-row "backing off" chip for a pending job with a future scheduledFor', async () => {
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      const jobs = [makeJob({ status: 'pending', scheduledFor: futureIso, rateLimitHits: 1 })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('backing off')).toBeInTheDocument();
      });
    });

    it('does not show the backing-off chip for a pending job with no scheduledFor', async () => {
      const jobs = [makeJob({ status: 'pending', scheduledFor: null })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
      });
      expect(screen.queryByText('backing off')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Filters — pure mapping onto the endpoint's params
  // =========================================================================

  describe('Filter → query mapping (pure)', () => {
    const filter = (columnId: string, value: unknown): DataTableFilterModel => [
      { columnId, operator: 'is', value: value as never },
    ];

    it('maps a status filter to `status`', () => {
      expect(toJobQuery(filter('status', 'failed'))).toEqual({ status: 'failed' });
    });

    it('maps a type filter to `type`', () => {
      expect(toJobQuery(filter('type', 'face_detection'))).toEqual({ type: 'face_detection' });
    });

    it.each(['4h', '24h', '7d', '30d'])(
      'maps a processedWithin filter of %s straight through',
      (window) => {
        expect(toJobQuery(filter('processedWithin', window))).toEqual({
          processedWithin: window,
        });
      },
    );

    it('never emits processedWithin=all — the absence of the filter IS "all"', () => {
      expect(toJobQuery(filter('processedWithin', 'all'))).toEqual({});
      expect(toJobQuery([])).toEqual({});
    });

    it('maps the backing-off filter to `scheduled: true`', () => {
      expect(toJobQuery(filter('backingOff', 'true'))).toEqual({ scheduled: true });
    });

    it('drops `status` whenever `scheduled` is set (the API forces status=pending)', () => {
      const model: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'failed' },
        { columnId: 'backingOff', operator: 'is', value: 'true' },
      ];
      const query = toJobQuery(model);
      expect(query.scheduled).toBe(true);
      expect(query.status).toBeUndefined();
      expect('status' in query).toBe(false);
    });

    it('composes processedWithin with the other filters', () => {
      const model: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'failed' },
        { columnId: 'type', operator: 'is', value: 'auto_tagging' },
        { columnId: 'processedWithin', operator: 'is', value: '7d' },
      ];
      expect(toJobQuery(model)).toEqual({
        status: 'failed',
        type: 'auto_tagging',
        processedWithin: '7d',
      });
    });

    it('ignores operators and enum values this endpoint cannot express', () => {
      expect(
        toJobQuery([
          { columnId: 'status', operator: 'isNot', value: 'failed' },
          { columnId: 'status', operator: 'is', value: 'bogus' },
          { columnId: 'processedWithin', operator: 'is', value: '99y' },
          { columnId: 'lastError', operator: 'is', value: 'boom' },
        ]),
      ).toEqual({});
    });
  });

  describe('Filter normalization (pure)', () => {
    it('keeps only the last filter per column — every param is single-valued', () => {
      const model: DataTableFilterModel = [
        { columnId: 'type', operator: 'is', value: 'face_detection' },
        { columnId: 'type', operator: 'is', value: 'auto_tagging' },
      ];
      expect(normalizeJobFilters(model)).toEqual([
        { columnId: 'type', operator: 'is', value: 'auto_tagging' },
      ]);
    });

    it('makes status and backing-off mutually exclusive, last one wins', () => {
      const statusThenBackoff: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'failed' },
        { columnId: 'backingOff', operator: 'is', value: 'true' },
      ];
      expect(normalizeJobFilters(statusThenBackoff)).toEqual([
        { columnId: 'backingOff', operator: 'is', value: 'true' },
      ]);

      const backoffThenStatus: DataTableFilterModel = [
        { columnId: 'backingOff', operator: 'is', value: 'true' },
        { columnId: 'status', operator: 'is', value: 'running' },
      ];
      expect(normalizeJobFilters(backoffThenStatus)).toEqual([
        { columnId: 'status', operator: 'is', value: 'running' },
      ]);
    });

    it('leaves an already-legal model alone, by reference', () => {
      const model: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'failed' },
        { columnId: 'processedWithin', operator: 'is', value: '24h' },
      ];
      expect(normalizeJobFilters(model)).toBe(model);
    });
  });

  // =========================================================================
  // Filters — through the rendered filter bar
  // =========================================================================

  describe('Filter bar', () => {
    it('offers the filter-only columns alongside the real ones', async () => {
      const user = userEvent.setup();
      renderPage();

      const combo = await screen.findByRole('combobox', { name: 'Column' });
      await user.click(combo);

      expect(await screen.findByRole('option', { name: 'Status' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Type' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Processed within' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Backing off' })).toBeInTheDocument();
    });

    it('does not draw a Processed within / Backing off COLUMN in the grid', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [makeJob({ id: 'job-1' })] }));

      renderPage();

      const grid = await screen.findByRole('grid', { name: /enrichment jobs/i });
      await waitFor(() => {
        expect(within(grid).getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
      });
      expect(
        within(grid).queryByRole('columnheader', { name: 'Processed within' }),
      ).not.toBeInTheDocument();
      expect(
        within(grid).queryByRole('columnheader', { name: 'Backing off' }),
      ).not.toBeInTheDocument();
    });

    it('sends status=failed and resets to page 1 when a Status filter is applied', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(
        makeJobsHook({ setFilters, filters: { page: 3, pageSize: 20 } }),
      );
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Status', 'Failed');

      expect(setFilters).toHaveBeenCalledWith({ status: 'failed', page: 1, pageSize: 20 });
    });

    it('sends type= when a Type filter is applied, from the live byType breakdown', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Type', 'auto_tagging');

      expect(setFilters).toHaveBeenCalledWith({ type: 'auto_tagging', page: 1, pageSize: 20 });
    });

    it('sends processedWithin=24h — its own window, not a date range', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Processed within', 'Last 24 hours');

      expect(setFilters).toHaveBeenCalledWith({
        processedWithin: '24h',
        page: 1,
        pageSize: 20,
      });
    });

    it('offers only `is` on processedWithin — no before/after/between the API cannot answer', async () => {
      const user = userEvent.setup();
      renderPage();

      await pickOption(user, 'Column', 'Processed within');
      await user.click(await screen.findByRole('combobox', { name: 'Operator' }));

      const options = await screen.findAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['is']);
    });

    it('sends scheduled=true (and no status) when Backing off is applied', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Backing off', /in retry delay/i);

      expect(setFilters).toHaveBeenCalledWith({ scheduled: true, page: 1, pageSize: 20 });
      const sent = setFilters.mock.calls.at(-1)![0];
      expect('status' in sent).toBe(false);
    });

    it('applying Backing off replaces an active Status filter (chip and query both)', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Status', 'Failed');
      expect(await screen.findByText('Status is Failed')).toBeInTheDocument();

      await addFilter(user, 'Backing off', /in retry delay/i);

      await waitFor(() => {
        expect(screen.queryByText('Status is Failed')).not.toBeInTheDocument();
      });
      expect(setFilters).toHaveBeenLastCalledWith({ scheduled: true, page: 1, pageSize: 20 });
    });

    it('keeps processedWithin when a Status filter is added on top of it', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Processed within', 'Last 7 days');
      await addFilter(user, 'Status', 'Running');

      expect(setFilters).toHaveBeenLastCalledWith({
        processedWithin: '7d',
        status: 'running',
        page: 1,
        pageSize: 20,
      });
    });

    it('removing a filter chip clears the param', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setFilters }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Status', 'Failed');

      const chip = await screen.findByText('Status is Failed');
      const deleteIcon = chip.closest('.MuiChip-root')!.querySelector('.MuiChip-deleteIcon')!;
      await user.click(deleteIcon);

      expect(setFilters).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 });
    });

    it('scopes "Retry all failed" to an active type filter', async () => {
      const retryAllFailed = vi.fn().mockResolvedValue({ retried: 2 });
      mockUseJobs.mockReturnValue(makeJobsHook({ retryAllFailed }));
      const user = userEvent.setup();

      renderPage();
      await addFilter(user, 'Type', 'auto_tagging');

      const button = await screen.findByRole('button', {
        name: /retry all failed \(auto_tagging\)/i,
      });
      await user.click(button);

      expect(retryAllFailed).toHaveBeenCalledWith('auto_tagging');
    });
  });

  // =========================================================================
  // THE regression this migration had to not cause
  // =========================================================================

  describe('Auto-refresh does not disturb table state', () => {
    it('keeps the auto-refresh toggle and reports it to the hook', async () => {
      const setAutoRefresh = vi.fn();
      mockUseJobs.mockReturnValue(makeJobsHook({ setAutoRefresh }));
      const user = userEvent.setup();

      renderPage();

      // MUI's Switch input carries role="switch", not "checkbox".
      const toggle = await screen.findByRole('switch', { name: /auto-refresh/i });
      expect(toggle).toBeChecked();
      await user.click(toggle);
      expect(setAutoRefresh).toHaveBeenCalledWith(false);
    });

    it('preserves selection, filters AND an expanded row across a poll tick', async () => {
      // Tablet width: `detail` columns fold into a row expander, so all three
      // pieces of state (selection, filter chips, expansion) are observable in
      // one render.
      setInitialContainerWidth(800);

      const first = [
        makeJob({ id: 'job-1', type: 'face_detection', status: 'failed', attempts: 1 }),
        makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded', attempts: 1 }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: first }));
      const user = userEvent.setup();

      const { rerender } = renderPage();

      // 1. a filter
      await user.click(await screen.findByTestId('datatable-filter-toggle'));
      await addFilter(user, 'Status', 'Failed');
      expect(await screen.findByText('Status is Failed')).toBeInTheDocument();

      // 2. a selection
      const checkbox = await screen.findByRole('checkbox', { name: 'Select face_detection' });
      await user.click(checkbox);
      await waitFor(() => {
        expect(screen.getByTestId('datatable-bulk-action-bar')).toBeInTheDocument();
      });

      // 3. an expanded row
      const expander = await screen.findByRole('button', {
        name: 'Show details for face_detection',
      });
      await user.click(expander);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Hide details for face_detection' }),
        ).toBeInTheDocument();
      });

      // --- the poll: same ids, brand-new objects and a brand-new array -------
      const polled = [
        makeJob({ id: 'job-1', type: 'face_detection', status: 'failed', attempts: 2 }),
        makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded', attempts: 2 }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: polled, stats: makeStats({ total: 11 }) }));
      rerender(<JobsPage />);

      // fresh data landed…
      await waitFor(() => {
        expect(screen.getByText(/total: 11/i)).toBeInTheDocument();
      });

      // …and nothing the operator had done was thrown away.
      expect(screen.getByText('Status is Failed')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select face_detection' })).toBeChecked();
      expect(screen.getByTestId('datatable-bulk-action-bar')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Hide details for face_detection' }),
      ).toBeInTheDocument();
    });

    it('drops a selected id that the poll retired, and keeps the ones still present', async () => {
      const first = [
        makeJob({ id: 'job-1', type: 'face_detection', status: 'failed' }),
        makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded' }),
      ];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: first }));
      const user = userEvent.setup();

      const { rerender } = renderPage();

      await user.click(await screen.findByRole('checkbox', { name: 'Select face_detection' }));
      await user.click(await screen.findByRole('checkbox', { name: 'Select auto_tagging' }));
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 selected/i)).toBeInTheDocument();
      });

      // job-1 finished and fell off the page.
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded' })] }),
      );
      rerender(<JobsPage />);

      await waitFor(() => {
        expect(screen.getByText(/1 of 1 selected/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('checkbox', { name: 'Select auto_tagging' })).toBeChecked();
    });

    it('does not blank the table while a refetch is in flight', async () => {
      const jobs = [makeJob({ id: 'job-1', type: 'face_detection' })];
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs, jobsLoading: true }));

      renderPage();

      // Rows stay mounted beneath the loading overlay (the pre-#258 page
      // replaced the whole table with a spinner).
      await waitFor(() => {
        expect(screen.getByText('face_detection')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  describe('Pagination', () => {
    it('reports a 1-based page to the API when the next page is requested', async () => {
      const setFilters = vi.fn();
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          setFilters,
          jobs: [makeJob({ id: 'job-1' })],
          filters: { page: 1, pageSize: 20 },
          meta: { page: 1, pageSize: 20, totalItems: 60, totalPages: 3 },
        }),
      );
      const user = userEvent.setup();

      renderPage();

      const next = await screen.findByRole('button', { name: /go to next page/i });
      await user.click(next);

      expect(setFilters).toHaveBeenCalledWith({ page: 2, pageSize: 20 });
    });
  });

  // =========================================================================
  // Row actions
  // =========================================================================

  describe('Row actions', () => {
    async function openRowMenu(user: ReturnType<typeof userEvent.setup>, rowLabel: string) {
      const trigger = await screen.findByRole('button', { name: `Row actions for ${rowLabel}` });
      await user.click(trigger);
    }

    it.each([
      ['failed', false],
      ['succeeded', false],
      ['pending', true],
      ['running', true],
    ])('Re-run for a %s job is disabled=%s', async (status, disabled) => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-1', status })] }),
      );
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'face_detection');

      const item = await screen.findByRole('menuitem', { name: /re-run/i });
      if (disabled) expect(item).toHaveAttribute('aria-disabled', 'true');
      else expect(item).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('Delete is disabled for a running job and enabled for a pending one', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [makeJob({ status: 'running' })] }));
      const user = userEvent.setup();

      const { unmount } = renderPage();
      await openRowMenu(user, 'face_detection');
      expect(await screen.findByRole('menuitem', { name: /delete/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      unmount();

      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [makeJob({ status: 'pending' })] }));
      renderPage();
      await openRowMenu(user, 'face_detection');
      expect(await screen.findByRole('menuitem', { name: /delete/i })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('calls retryJob with the job id and reports success', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-abc-1234', status: 'failed' })], retryJob }),
      );
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'face_detection');
      await user.click(await screen.findByRole('menuitem', { name: /re-run/i }));

      expect(retryJob).toHaveBeenCalledWith('job-abc-1234');
      await waitFor(() => {
        expect(screen.getByText(/job-abc-… reset to pending/i)).toBeInTheDocument();
      });
    });

    it('confirms before deleting, and cancels cleanly', async () => {
      const deleteJob = vi.fn();
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-del-1', status: 'pending' })], deleteJob }),
      );
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'face_detection');
      await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/delete job\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(deleteJob).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('calls deleteJob when the confirm dialog is accepted', async () => {
      const deleteJob = vi.fn().mockResolvedValue(undefined);
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-del-abc12345', status: 'pending' })], deleteJob }),
      );
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'face_detection');
      await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      expect(deleteJob).toHaveBeenCalledWith('job-del-abc12345');
      await waitFor(() => {
        expect(screen.getByText(/deleted/i)).toBeInTheDocument();
      });
    });

    it('downloads the job JSON', async () => {
      const createObjectURL = vi.fn().mockReturnValue('blob:mock');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(global.URL, 'createObjectURL', {
        value: createObjectURL,
        writable: true,
      });
      Object.defineProperty(global.URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        writable: true,
      });
      const click = vi.fn();
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = vi
        .spyOn(document, 'createElement')
        .mockImplementation((tag: string) => {
          const el = originalCreateElement(tag);
          if (tag === 'a') vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(click);
          return el;
        });

      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [makeJob({ id: 'job-dl-2' })] }));
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'face_detection');
      await user.click(await screen.findByRole('menuitem', { name: /download json/i }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalled();

      createElementSpy.mockRestore();
    });
  });

  // =========================================================================
  // Selection-scoped bulk action
  // =========================================================================

  describe('Selection bulk action', () => {
    it('re-runs every retryable selected job and clears the selection', async () => {
      const retryJob = vi.fn().mockResolvedValue(undefined);
      mockUseJobs.mockReturnValue(
        makeJobsHook({
          retryJob,
          jobs: [
            makeJob({ id: 'job-1', type: 'face_detection', status: 'failed' }),
            makeJob({ id: 'job-2', type: 'auto_tagging', status: 'succeeded' }),
          ],
        }),
      );
      const user = userEvent.setup();

      renderPage();

      await user.click(await screen.findByRole('checkbox', { name: 'Select face_detection' }));
      await user.click(await screen.findByRole('checkbox', { name: 'Select auto_tagging' }));

      await user.click(await screen.findByRole('button', { name: /re-run selected/i }));

      await waitFor(() => {
        expect(retryJob).toHaveBeenCalledTimes(2);
      });
      expect(retryJob).toHaveBeenCalledWith('job-1');
      expect(retryJob).toHaveBeenCalledWith('job-2');
      await waitFor(() => {
        expect(screen.queryByTestId('datatable-bulk-action-bar')).not.toBeInTheDocument();
      });
    });

    it('disables the bulk action when nothing selected is retryable', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-1', status: 'running' })] }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: 'Select face_detection' }));

      expect(await screen.findByRole('button', { name: /re-run selected/i })).toBeDisabled();
    });
  });

  // =========================================================================
  // Queue-wide operations (unchanged by the migration)
  // =========================================================================

  describe('Queue-wide operations', () => {
    it('calls retryAllFailed and shows a snackbar', async () => {
      const retryAllFailed = vi.fn().mockResolvedValue({ retried: 3 });
      mockUseJobs.mockReturnValue(makeJobsHook({ retryAllFailed }));
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('button', { name: /retry all failed/i }));

      expect(retryAllFailed).toHaveBeenCalledWith(undefined);
      await waitFor(() => {
        expect(screen.getByText(/3 job\(s\) reset to pending/i)).toBeInTheDocument();
      });
    });

    it('calls resetStuck with no argument and shows a snackbar', async () => {
      const resetStuck = vi.fn().mockResolvedValue({ reset: 2 });
      mockUseJobs.mockReturnValue(
        makeJobsHook({ resetStuck, stats: makeStats({ stuckRunning: 5 }) }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('button', { name: /reset stuck/i }));

      // The service resolves `jobs.stuckThresholdMinutes` itself.
      expect(resetStuck).toHaveBeenCalledWith();
      await waitFor(() => {
        expect(screen.getByText(/2 stuck job\(s\) reset to pending/i)).toBeInTheDocument();
      });
    });

    it('disables "Retry all failed" when nothing has failed', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ stats: makeStats({ byStatus: { pending: 5, running: 0, succeeded: 0, failed: 0 } }) }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retry all failed/i })).toBeDisabled();
      });
    });

    it('disables "Reset stuck" when nothing is stuck', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset stuck/i })).toBeDisabled();
      });
    });

    it('renders the configured stuck threshold in the button label', async () => {
      mockUseJobs.mockReturnValue(
        makeJobsHook({ stats: makeStats({ stuckRunning: 5, stuckThresholdMinutes: 45 }) }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset stuck \(>45 min\)/i })).toBeInTheDocument();
      });
    });

    it('falls back to a "3 min" label when stats is null', async () => {
      mockUseJobs.mockReturnValue(makeJobsHook({ stats: null }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset stuck \(>3 min\)/i })).toBeInTheDocument();
      });
    });

    it('queues a thumbnail repair and reports the job id', async () => {
      const repairThumbnails = vi
        .fn()
        .mockResolvedValue({ jobId: 'abcd1234-ffff', status: 'pending' });
      mockUseJobs.mockReturnValue(makeJobsHook({ repairThumbnails }));
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('button', { name: /repair missing thumbnails/i }));

      expect(repairThumbnails).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByText(/thumbnail repair queued \(job abcd1234…\)/i)).toBeInTheDocument();
      });
    });

    it('surfaces a failed repair in the error snackbar', async () => {
      const repairThumbnails = vi.fn().mockRejectedValue(new Error('Repair boom'));
      mockUseJobs.mockReturnValue(makeJobsHook({ repairThumbnails }));
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('button', { name: /repair missing thumbnails/i }));

      await waitFor(() => {
        expect(screen.getByText(/repair boom/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Phone
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('renders cards, and every row action is still reachable', async () => {
      setInitialContainerWidth(360);
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-1', status: 'failed' })] }),
      );
      const user = userEvent.setup();

      renderPage();

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');

      await user.click(
        await screen.findByRole('button', { name: 'Row actions for face_detection' }),
      );
      expect(await screen.findByRole('menuitem', { name: /re-run/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /download json/i })).toBeInTheDocument();
    });

    it('folds the detail columns behind "More details" rather than overflowing', async () => {
      setInitialContainerWidth(360);
      mockUseJobs.mockReturnValue(
        makeJobsHook({ jobs: [makeJob({ id: 'job-1', lastError: 'Timeout after 30s' })] }),
      );
      const user = userEvent.setup();

      renderPage();

      const toggle = await screen.findByTestId('datatable-card-detail-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      await waitFor(() => {
        expect(screen.getByText('Timeout after 30s')).toBeInTheDocument();
      });
    });

    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);
      mockUseJobs.mockReturnValue(makeJobsHook({ jobs: [makeJob({ id: 'job-1' })] }));

      renderPage();

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});
