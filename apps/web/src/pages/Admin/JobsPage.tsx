/**
 * Admin → Job Queue (`/admin/settings/jobs`).
 *
 * Migrated onto the shared DataTable in issue #258 (epic #238) — the pilot
 * migration. What that replaced, and why it mattered here first:
 *
 *   - a hand-rolled 13-column `<Table>` that could only be read by scrolling
 *     the document sideways on anything narrower than a laptop;
 *   - four bespoke fixed-width filter controls (`minWidth: 160/200/160` plus a
 *     switch) that overflowed the row well before a phone;
 *   - a `TablePagination` footer with ~420px of intrinsic width;
 *   - a `Menu` + confirm dialog reimplemented per page.
 *
 * All four are now the component's, from one `DataTableColumn[]`
 * (`./jobsTable.tsx`). The page keeps only what is genuinely its own: the stats
 * strip, the queue-wide operations, and the mapping from the normalized filter
 * model onto this endpoint's params.
 *
 * ## The auto-refresh contract (the regression this migration had to not cause)
 *
 * `useJobs` polls every 5 seconds. A poll must not disturb selection, an
 * expanded card / expanded tablet row, scroll position, or the filter state.
 * Three things make that true, and all three are easy to lose:
 *
 * 1. **The table is rendered unconditionally.** The old code swapped the whole
 *    `<TableContainer>` for a spinner while loading; doing that here would
 *    unmount the renderer on every fetch and take its expansion state and the
 *    page's scroll offset with it. `loading` is a prop — the overlay draws over
 *    rows that stay mounted.
 * 2. **Every piece of user state lives above the table.** Selection, the filter
 *    model and pagination are page state; the poll only ever replaces `jobs`.
 * 3. **`columns` is memoized on the job-type SET, not on `stats`.** `stats` is
 *    a fresh object every poll, so a naive dependency would rebuild the column
 *    array (and the Type filter's `enumValues`) 12 times a minute.
 *
 * ## What is deliberately absent
 *
 * No `sort` config: `GET /api/admin/jobs` accepts no sort param, and a sortable
 * header the server cannot honour is the affordance the contract refuses. No
 * `quickSearch`: the endpoint has no free-text param either.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  Stack,
  Button,
  CircularProgress,
  Alert,
  Snackbar,
  Tooltip,
  FormControlLabel,
  Switch,
  Badge,
  Link,
} from '@mui/material';
import {
  WorkHistory as WorkHistoryIcon,
  Refresh as RefreshIcon,
  Replay as RetryIcon,
  Delete as DeleteIcon,
  Warning as WarningIcon,
  Download as DownloadIcon,
  Schedule as ScheduleIcon,
  QueryStats as QueryStatsIcon,
  AutoFixHigh as HealingIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobs } from '../../hooks/useJobs';
import { listJobs } from '../../services/jobs';
import type { EnrichmentJobDto } from '../../services/jobs';
import {
  DataTable,
  type DataTableBulkAction,
  type DataTableFilterModel,
  type DataTableRowAction,
} from '../../components/datatable';
import {
  JOB_TABLE_ID,
  buildJobColumns,
  downloadJobJson,
  normalizeJobFilters,
  shortId,
  toJobQuery,
} from './jobsTable';

const DEFAULT_PAGE_SIZE = 20;

/** Only a settled job can be reset to pending. */
function isRetryable(job: EnrichmentJobDto | undefined): boolean {
  return job?.status === 'failed' || job?.status === 'succeeded';
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function JobsPageContent() {
  const {
    stats,
    jobs,
    meta,
    statsLoading,
    jobsLoading,
    statsError,
    jobsError,
    mutating,
    filters: jobQuery,
    setFilters,
    autoRefresh,
    setAutoRefresh,
    refresh,
    retryJob,
    retryAllFailed,
    resetStuck,
    repairThumbnails,
    deleteJob,
  } = useJobs({ autoRefresh: true });

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // --- Controlled table state (all of it lives HERE, above the table) --------

  const [filterModel, setFilterModel] = useState<DataTableFilterModel>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const page = (jobQuery.page ?? 1) - 1; // the API is 1-based, the table 0-based
  const pageSize = jobQuery.pageSize ?? DEFAULT_PAGE_SIZE;

  const applyQuery = useCallback(
    (model: DataTableFilterModel, nextPage: number, nextPageSize: number) => {
      setFilters({ ...toJobQuery(model), page: nextPage, pageSize: nextPageSize });
    },
    [setFilters],
  );

  const handleFiltersChange = useCallback(
    (next: DataTableFilterModel) => {
      const normalized = normalizeJobFilters(next);
      setFilterModel(normalized);
      // A new filter invalidates the current offset.
      applyQuery(normalized, 1, pageSize);
    },
    [applyQuery, pageSize],
  );

  const handlePaginationChange = useCallback(
    ({ page: nextPage, pageSize: nextPageSize }: { page: number; pageSize: number }) => {
      applyQuery(filterModel, nextPage + 1, nextPageSize);
    },
    [applyQuery, filterModel],
  );

  // A poll can retire a job that is currently selected. Drop ids that no longer
  // exist — and ONLY those: the same-reference early return means a poll that
  // changes nothing does not re-render, which is what keeps a selection alive
  // across ticks rather than merely looking like it does.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const live = new Set(jobs.map((job) => job.id));
      let dropped = false;
      const next = new Set<string>();
      for (const id of current) {
        if (live.has(id)) next.add(id);
        else dropped = true;
      }
      return dropped ? next : current;
    });
  }, [jobs]);

  // --- Columns ---------------------------------------------------------------

  // Keyed on the job-type SET rather than on `stats`, which is a new object on
  // every 5s poll — see the module docblock.
  const typeOptionsKey = useMemo(
    () =>
      (stats?.byType ?? [])
        .map((entry) => entry.type)
        .sort()
        .join(','),
    [stats],
  );
  const columns = useMemo(
    () => buildJobColumns(typeOptionsKey === '' ? [] : typeOptionsKey.split(',')),
    [typeOptionsKey],
  );

  // --- Queue-wide operations -------------------------------------------------

  const activeTypeFilter = toJobQuery(filterModel).type;

  const handleRetryAllFailed = async () => {
    try {
      const result = await retryAllFailed(activeTypeFilter);
      setSuccessMessage(`${result.retried} job(s) reset to pending`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to retry failed jobs');
    }
  };

  const handleResetStuck = async () => {
    try {
      const result = await resetStuck();
      setSuccessMessage(`${result.reset} stuck job(s) reset to pending`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to reset stuck jobs');
    }
  };

  const handleRepairThumbnails = async () => {
    try {
      const result = await repairThumbnails();
      setSuccessMessage(`Thumbnail repair queued (job ${shortId(result.jobId)}…)`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to queue thumbnail repair');
    }
  };

  // --- Row + bulk actions ----------------------------------------------------

  const handleRetryJob = useCallback(
    async (job: EnrichmentJobDto) => {
      try {
        await retryJob(job.id);
        setSuccessMessage(`Job ${shortId(job.id)}… reset to pending`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to retry job');
      }
    },
    [retryJob],
  );

  const handleDeleteJob = useCallback(
    async (job: EnrichmentJobDto) => {
      try {
        await deleteJob(job.id);
        setSuccessMessage(`Job ${shortId(job.id)}… deleted`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to delete job');
      }
    },
    [deleteJob],
  );

  const jobsById = useMemo(
    () => new Map(jobs.map((job) => [job.id, job])),
    [jobs],
  );

  const handleRetrySelected = useCallback(
    async (ids: string[]) => {
      const targets = ids.filter((id) => isRetryable(jobsById.get(id)));
      if (targets.length === 0) {
        setErrorMessage('None of the selected jobs can be re-run (only failed or succeeded jobs can).');
        return;
      }
      try {
        // Sequential: the queue is the thing being repaired, and N parallel
        // retries against a struggling worker is not a kindness.
        for (const id of targets) await retryJob(id);
        setSuccessMessage(`${targets.length} job(s) reset to pending`);
        setSelectedIds(new Set());
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to re-run selected jobs');
      }
    },
    [jobsById, retryJob],
  );

  const rowActions = useMemo<DataTableRowAction<EnrichmentJobDto>[]>(
    () => [
      {
        id: 'download',
        label: 'Download JSON',
        icon: <DownloadIcon fontSize="small" />,
        onClick: downloadJobJson,
      },
      {
        id: 'retry',
        label: 'Re-run',
        icon: <RetryIcon fontSize="small" color="primary" />,
        disabled: (job) => mutating || !isRetryable(job),
        onClick: (job) => void handleRetryJob(job),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        disabled: (job) => mutating || job.status === 'running',
        confirm: {
          title: 'Delete job?',
          description: (job) =>
            `Job ${shortId(job.id)}… will be permanently removed. This cannot be undone.`,
          confirmLabel: 'Delete',
        },
        onClick: (job) => void handleDeleteJob(job),
      },
    ],
    [mutating, handleRetryJob, handleDeleteJob],
  );

  const bulkActions = useMemo<DataTableBulkAction[]>(
    () => [
      {
        id: 'retry-selected',
        label: 'Re-run selected',
        icon: <RetryIcon fontSize="small" />,
        disabled: (ids) => mutating || !ids.some((id) => isRetryable(jobsById.get(id))),
        onClick: (ids) => void handleRetrySelected(ids),
      },
    ],
    [mutating, jobsById, handleRetrySelected],
  );

  // --- Export ----------------------------------------------------------------

  // "All matching rows" replays THIS page's own query, so the CSV can only ever
  // contain what the operator's own list request already returns (§16.6).
  const csvExport = useMemo(
    () => ({
      filename: 'enrichment-jobs',
      fetchAllRows: async ({
        page: exportPage,
        pageSize: exportPageSize,
      }: {
        page: number;
        pageSize: number;
      }) => {
        const response = await listJobs({
          ...toJobQuery(filterModel),
          page: exportPage + 1,
          pageSize: exportPageSize,
        });
        return response.items;
      },
    }),
    [filterModel],
  );

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Back link */}
        <Link
          component={RouterLink}
          to="/admin/settings"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Settings
        </Link>

        {/* Page header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
            mb: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <WorkHistoryIcon color="primary" />
            <Typography variant="h4" component="h1">
              Job Queue
            </Typography>
            {stats && stats.stuckRunning > 0 && (
              <Chip
                icon={<WarningIcon />}
                label={`${stats.stuckRunning} stuck`}
                color="warning"
                size="small"
              />
            )}
          </Box>
          <Button
            component={RouterLink}
            to="/admin/settings/jobs/insights"
            variant="outlined"
            size="small"
            startIcon={<QueryStatsIcon />}
            sx={{ flexShrink: 0 }}
          >
            View insights &amp; ETA
          </Button>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Monitor and manage enrichment job queue. Auto-refreshes every 5 seconds.
        </Typography>

        {/* Stats error */}
        {statsError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {statsError}
          </Alert>
        )}

        {/* Summary cards */}
        {stats && (
          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
              Queue summary
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
              <Chip label={`Total: ${stats.total}`} variant="filled" />
              <Chip
                label={`Pending: ${stats.byStatus.pending}`}
                color="default"
                variant="outlined"
              />
              <Chip
                label={`Running: ${stats.byStatus.running}`}
                color="info"
                variant="outlined"
              />
              <Chip
                label={`Succeeded: ${stats.byStatus.succeeded}`}
                color="success"
                variant="outlined"
              />
              <Chip
                label={`Failed: ${stats.byStatus.failed}`}
                color="error"
                variant="outlined"
              />
              {stats.stuckRunning > 0 && (
                <Badge badgeContent={stats.stuckRunning} color="warning">
                  <Chip label="Stuck running" color="warning" variant="outlined" />
                </Badge>
              )}
              {stats.scheduled > 0 && (
                <Tooltip title="Pending jobs waiting on backoff before the worker will retry them" arrow>
                  <Chip
                    icon={<ScheduleIcon />}
                    label={`Scheduled (backing off): ${stats.scheduled}`}
                    color="info"
                    variant="outlined"
                    sx={{ cursor: 'help' }}
                  />
                </Tooltip>
              )}
            </Box>

            {/* Per-type breakdown */}
            {stats.byType.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                  By type
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {stats.byType.map((bt) => (
                    <Chip
                      key={bt.type}
                      label={`${bt.type}: ${bt.total}`}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Box>
              </Box>
            )}
          </Paper>
        )}

        {statsLoading && !stats && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {/* Queue-wide operations. These are NOT selection-scoped — they act on
            the whole queue — so they stay page chrome rather than becoming
            DataTable bulk actions (which are, by contract, about the current
            selection). */}
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ flexWrap: 'wrap', alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <Button
              variant="contained"
              startIcon={<RetryIcon />}
              disabled={mutating || !stats || stats.byStatus.failed === 0}
              onClick={() => void handleRetryAllFailed()}
            >
              Retry all failed{activeTypeFilter ? ` (${activeTypeFilter})` : ''}
            </Button>

            <Button
              variant="outlined"
              color="warning"
              startIcon={<WarningIcon />}
              disabled={mutating || !stats || stats.stuckRunning === 0}
              onClick={() => void handleResetStuck()}
            >
              Reset stuck (&gt;{stats?.stuckThresholdMinutes ?? 3} min)
            </Button>

            <Button
              variant="outlined"
              startIcon={<HealingIcon />}
              disabled={mutating}
              onClick={() => void handleRepairThumbnails()}
            >
              Repair missing thumbnails
            </Button>

            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              disabled={statsLoading || jobsLoading}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>

            <FormControlLabel
              control={
                <Switch
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  size="small"
                />
              }
              label="Auto-refresh"
              sx={{ ml: { sm: 'auto' } }}
            />
          </Stack>
        </Paper>

        {/*
          Rendered unconditionally, always. Gating this on `!jobsLoading` — as
          the pre-#258 page did — remounts the renderer on every fetch and takes
          expansion state and scroll position with it. See the module docblock.
        */}
        <DataTable<EnrichmentJobDto>
          columns={columns}
          rows={jobs}
          rowId={(job) => job.id}
          tableId={JOB_TABLE_ID}
          ariaLabel="Enrichment jobs"
          density="compact"
          loading={jobsLoading}
          error={jobsError}
          emptyState={<span>No jobs found</span>}
          pagination={{
            page,
            pageSize,
            total: meta?.totalItems ?? jobs.length,
            onPaginationChange: handlePaginationChange,
            pageSizeOptions: [10, 20, 50, 100],
          }}
          filters={filterModel}
          onFiltersChange={handleFiltersChange}
          selection={{ selectedIds, onSelectionChange: setSelectedIds }}
          rowActions={rowActions}
          bulkActions={bulkActions}
          csvExport={csvExport}
        />
      </Box>

      {/* Success snackbar */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      {/* Error snackbar */}
      <Snackbar
        open={!!errorMessage}
        autoHideDuration={5000}
        onClose={() => setErrorMessage(null)}
      >
        <Alert severity="error" onClose={() => setErrorMessage(null)}>
          {errorMessage}
        </Alert>
      </Snackbar>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Admin-gated export (mirrors FaceSettingsPage pattern)
// ---------------------------------------------------------------------------

export default function JobsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <JobsPageContent />;
}
