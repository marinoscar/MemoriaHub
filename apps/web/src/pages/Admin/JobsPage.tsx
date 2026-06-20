import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  Stack,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Snackbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Tooltip,
  IconButton,
  FormControlLabel,
  Switch,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Badge,
  Menu,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  WorkHistory as WorkHistoryIcon,
  Refresh as RefreshIcon,
  Replay as RetryIcon,
  Delete as DeleteIcon,
  Warning as WarningIcon,
  MoreVert as MoreVertIcon,
  Download as DownloadIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobs } from '../../hooks/useJobs';
import type { EnrichmentJobDto, JobStatus } from '../../services/jobs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<JobStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  pending: 'default',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
};

function StatusChip({ status }: { status: JobStatus }) {
  return (
    <Chip
      label={status}
      color={STATUS_COLORS[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

function downloadJobJson(job: EnrichmentJobDto): void {
  const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `enrichment-job-${job.id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Confirm delete dialog
// ---------------------------------------------------------------------------

interface ConfirmDeleteDialogProps {
  open: boolean;
  jobId: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteDialog({ open, jobId, onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Delete job?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Job <strong>{shortId(jobId)}&hellip;</strong> will be permanently removed. This cannot be
          undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onConfirm} color="error" variant="contained">
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
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
    filters,
    setFilters,
    autoRefresh,
    setAutoRefresh,
    refresh,
    retryJob,
    retryAllFailed,
    resetStuck,
    deleteJob,
  } = useJobs({ autoRefresh: true });

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<string | null>(null); // job id or null
  const [menuState, setMenuState] = useState<{ anchorEl: HTMLElement; job: EnrichmentJobDto } | null>(null);

  // Filter state (controlled locally, applied to hook via setFilters)
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  const applyFilters = (newStatus: string, newType: string, page = 1) => {
    setFilters({
      status: (newStatus as JobStatus) || undefined,
      type: newType || undefined,
      page,
      pageSize: filters.pageSize ?? 20,
    });
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    applyFilters(value, typeFilter);
  };

  const handleTypeChange = (value: string) => {
    setTypeFilter(value);
    applyFilters(statusFilter, value);
  };

  const handlePageChange = (_: unknown, newPage: number) => {
    applyFilters(statusFilter, typeFilter, newPage + 1); // MUI is 0-based
  };

  const handleRowsPerPageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters({
      ...filters,
      pageSize: Number(e.target.value),
      page: 1,
    });
  };

  // Bulk actions
  const handleRetryAllFailed = async () => {
    try {
      const result = await retryAllFailed(typeFilter || undefined);
      setSuccessMessage(`${result.retried} job(s) reset to pending`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to retry failed jobs');
    }
  };

  const handleResetStuck = async () => {
    try {
      const result = await resetStuck(10);
      setSuccessMessage(`${result.reset} stuck job(s) reset to pending`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to reset stuck jobs');
    }
  };

  // Per-row actions
  const handleRetryJob = async (job: EnrichmentJobDto) => {
    try {
      await retryJob(job.id);
      setSuccessMessage(`Job ${shortId(job.id)}… reset to pending`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to retry job');
    }
  };

  const handleDeleteJob = async () => {
    if (!deleteDialog) return;
    const id = deleteDialog;
    setDeleteDialog(null);
    try {
      await deleteJob(id);
      setSuccessMessage(`Job ${shortId(id)}… deleted`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to delete job');
    }
  };

  const typeOptions = stats?.byType.map((bt) => bt.type) ?? [];

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Page header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
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

        {/* Bulk action bar */}
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
              Retry all failed{typeFilter ? ` (${typeFilter})` : ''}
            </Button>

            <Button
              variant="outlined"
              color="warning"
              startIcon={<WarningIcon />}
              disabled={mutating || !stats || stats.stuckRunning === 0}
              onClick={() => void handleResetStuck()}
            >
              Reset stuck (&gt;10 min)
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

        {/* Filters */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Status</InputLabel>
            <Select
              label="Status"
              value={statusFilter}
              onChange={(e) => handleStatusChange(e.target.value)}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="running">Running</MenuItem>
              <MenuItem value="succeeded">Succeeded</MenuItem>
              <MenuItem value="failed">Failed</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Type</InputLabel>
            <Select
              label="Type"
              value={typeFilter}
              onChange={(e) => handleTypeChange(e.target.value)}
            >
              <MenuItem value="">All types</MenuItem>
              {typeOptions.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>

        {/* Jobs error */}
        {jobsError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {jobsError}
          </Alert>
        )}

        {/* Jobs table */}
        <Paper variant="outlined">
          {jobsLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          )}

          {!jobsLoading && (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Type</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell>Model</TableCell>
                    <TableCell align="center">Priority</TableCell>
                    <TableCell align="center">Attempts</TableCell>
                    <TableCell>Last Error</TableCell>
                    <TableCell>Media Item</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Finished</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {jobs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        No jobs found
                      </TableCell>
                    </TableRow>
                  ) : (
                    jobs.map((job) => (
                      <TableRow key={job.id} hover>
                        <TableCell>
                          <Typography variant="body2" noWrap sx={{ maxWidth: 160 }}>
                            {job.type}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <StatusChip status={job.status} />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {job.reason}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ maxWidth: 180 }}>
                          {job.modelVersion ? (
                            <>
                              <Typography variant="body2" noWrap>
                                {job.modelVersion}
                              </Typography>
                              {job.providerKey && (
                                <Typography variant="caption" color="text.secondary" noWrap display="block">
                                  {job.providerKey}
                                </Typography>
                              )}
                            </>
                          ) : (
                            <Typography variant="body2" color="text.disabled">
                              —
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2">{job.priority}</Typography>
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2">{job.attempts}</Typography>
                        </TableCell>
                        <TableCell sx={{ maxWidth: 200 }}>
                          {job.lastError ? (
                            <Tooltip title={job.lastError} arrow>
                              <Typography
                                variant="body2"
                                color="error.main"
                                noWrap
                                sx={{ cursor: 'help' }}
                              >
                                {job.lastError}
                              </Typography>
                            </Tooltip>
                          ) : (
                            <Typography variant="body2" color="text.disabled">
                              —
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          {job.mediaItemId ? (
                            <Tooltip title={job.mediaItemId} arrow>
                              <Typography
                                variant="body2"
                                color="text.secondary"
                                sx={{ fontFamily: 'monospace', cursor: 'help' }}
                              >
                                {shortId(job.mediaItemId)}&hellip;
                              </Typography>
                            </Tooltip>
                          ) : (
                            <Tooltip title="System job — not scoped to a media item" arrow>
                              <Typography variant="body2" color="text.disabled" sx={{ cursor: 'help' }}>
                                Global
                              </Typography>
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {formatDate(job.createdAt)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {formatDate(job.startedAt)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {formatDate(job.finishedAt)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Actions">
                            <IconButton
                              size="small"
                              aria-label="Job actions"
                              onClick={(e) => setMenuState({ anchorEl: e.currentTarget, job })}
                            >
                              <MoreVertIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Menu
            anchorEl={menuState?.anchorEl}
            open={Boolean(menuState)}
            onClose={() => setMenuState(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            {/* Download JSON — always enabled */}
            <MenuItem
              onClick={() => {
                if (menuState) downloadJobJson(menuState.job);
                setMenuState(null);
              }}
            >
              <ListItemIcon>
                <DownloadIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Download JSON</ListItemText>
            </MenuItem>

            {/* Re-run — only for failed/succeeded; disabled while mutating */}
            <MenuItem
              disabled={
                !menuState ||
                !(menuState.job.status === 'failed' || menuState.job.status === 'succeeded') ||
                mutating
              }
              onClick={() => {
                if (menuState) void handleRetryJob(menuState.job);
                setMenuState(null);
              }}
            >
              <ListItemIcon>
                <RetryIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Re-run</ListItemText>
            </MenuItem>

            {/* Delete — disabled for running; disabled while mutating */}
            <MenuItem
              disabled={!menuState || menuState.job.status === 'running' || mutating}
              onClick={() => {
                if (menuState) setDeleteDialog(menuState.job.id);
                setMenuState(null);
              }}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon>
                <DeleteIcon fontSize="small" sx={{ color: 'error.main' }} />
              </ListItemIcon>
              <ListItemText>Delete</ListItemText>
            </MenuItem>
          </Menu>

          {meta && (
            <TablePagination
              component="div"
              count={meta.totalItems}
              page={(meta.page ?? 1) - 1} // MUI is 0-based
              rowsPerPage={meta.pageSize ?? 20}
              rowsPerPageOptions={[10, 20, 50, 100]}
              onPageChange={handlePageChange}
              onRowsPerPageChange={handleRowsPerPageChange}
            />
          )}
        </Paper>
      </Box>

      {/* Confirm delete dialog */}
      {deleteDialog && (
        <ConfirmDeleteDialog
          open
          jobId={deleteDialog}
          onConfirm={() => void handleDeleteJob()}
          onCancel={() => setDeleteDialog(null)}
        />
      )}

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
