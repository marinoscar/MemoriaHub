import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Button,
  CircularProgress,
  Alert,
  Tooltip,
  Divider,
} from '@mui/material';
import { Close as CloseIcon, Stop as StopIcon } from '@mui/icons-material';
import type { AdminWorkflowRun } from '../../../services/adminWorkflows';
import {
  runStatusColor,
  runStatusLabel,
  isTerminalRunStatus,
  formatRelativeTime,
  formatCount,
} from '../../../utils/workflowFormat';

// ---------------------------------------------------------------------------
// Admin workflow-runs drawer (issue #143).
//
// Presentational: the parent owns fetching runs for the selected workflow and
// the cancel-confirm flow. Cancel is offered on non-terminal runs only, and
// only when `canCancel` (Admin + jobs:write).
// ---------------------------------------------------------------------------

interface WorkflowRunsDrawerProps {
  open: boolean;
  workflowName: string | null;
  runs: AdminWorkflowRun[];
  loading: boolean;
  error: string | null;
  canCancel: boolean;
  cancellingRunId: string | null;
  onCancel: (run: AdminWorkflowRun) => void;
  onClose: () => void;
}

export function WorkflowRunsDrawer({
  open,
  workflowName,
  runs,
  loading,
  error,
  canCancel,
  cancellingRunId,
  onCancel,
  onClose,
}: WorkflowRunsDrawerProps) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 620 }, maxWidth: '100%' } } }}
    >
      <Box sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Run history
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {workflowName ?? 'Workflow'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close run history">
            <CloseIcon />
          </IconButton>
        </Box>

        <Divider sx={{ mb: 2 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {loading && runs.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : runs.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
            No runs for this workflow yet.
          </Typography>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell align="right">Matched</TableCell>
                  <TableCell align="right">Actioned</TableCell>
                  <TableCell align="right">Failed</TableCell>
                  <TableCell align="right">Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((run) => {
                  const terminal = isTerminalRunStatus(run.status);
                  return (
                    <TableRow key={run.id} hover>
                      <TableCell>
                        <Chip
                          size="small"
                          label={runStatusLabel(run.status)}
                          color={runStatusColor(run.status)}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {formatRelativeTime(run.startedAt ?? run.createdAt)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{formatCount(run.matchedCount)}</TableCell>
                      <TableCell align="right">{formatCount(run.succeededCount)}</TableCell>
                      <TableCell align="right">{formatCount(run.failedCount)}</TableCell>
                      <TableCell align="right">
                        {terminal ? (
                          <Typography variant="caption" color="text.disabled">
                            —
                          </Typography>
                        ) : (
                          <Tooltip
                            title={canCancel ? 'Cancel this run' : 'Requires jobs:write'}
                          >
                            <span>
                              <Button
                                size="small"
                                color="error"
                                startIcon={
                                  cancellingRunId === run.id ? (
                                    <CircularProgress size={14} />
                                  ) : (
                                    <StopIcon />
                                  )
                                }
                                disabled={!canCancel || cancellingRunId === run.id}
                                onClick={() => onCancel(run)}
                              >
                                Cancel
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
    </Drawer>
  );
}
