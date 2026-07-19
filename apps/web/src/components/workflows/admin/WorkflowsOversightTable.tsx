import {
  Card,
  CardContent,
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  Stack,
  Button,
  Tooltip,
  CircularProgress,
} from '@mui/material';
import {
  Block as BlockIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import type { AdminWorkflowListItem } from '../../../services/adminWorkflows';
import {
  triggerLabel,
  runStatusColor,
  runStatusLabel,
  formatRelativeTime,
  formatCount,
} from '../../../utils/workflowFormat';
import type { WorkflowSubjectType } from '../../../types/workflows';

// ---------------------------------------------------------------------------
// Workflows oversight table (issue #143).
//
// Every workflow across all circles. Props-driven for testability: the parent
// owns fetching, pagination, and the row-action handlers. Disable / cancel are
// gated by `canManage` (Admin + system_settings:write for disable).
// ---------------------------------------------------------------------------

const SUBJECT_LABELS: Record<WorkflowSubjectType, string> = {
  media_item: 'Media item',
};

function subjectLabel(subject: WorkflowSubjectType): string {
  return SUBJECT_LABELS[subject] ?? subject;
}

interface WorkflowsOversightTableProps {
  items: AdminWorkflowListItem[];
  loading: boolean;
  totalItems: number;
  page: number; // zero-based (MUI convention)
  pageSize: number;
  canManage: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onDisable: (item: AdminWorkflowListItem) => void;
  onViewRuns: (item: AdminWorkflowListItem) => void;
}

export function WorkflowsOversightTable({
  items,
  loading,
  totalItems,
  page,
  pageSize,
  canManage,
  onPageChange,
  onPageSizeChange,
  onDisable,
  onViewRuns,
}: WorkflowsOversightTableProps) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
          All workflows
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Every workflow across all circles, newest first.
        </Typography>

        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Circle</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Trigger</TableCell>
                <TableCell>Enabled</TableCell>
                <TableCell>Last run</TableCell>
                <TableCell align="right">Matched</TableCell>
                <TableCell align="right">Actioned</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                    <CircularProgress size={24} />
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    No workflows found.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((wf) => (
                  <TableRow key={wf.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {wf.circle?.name ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {wf.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{subjectLabel(wf.subjectType)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{triggerLabel(wf.trigger)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={wf.enabled ? 'Enabled' : 'Disabled'}
                        color={wf.enabled ? 'success' : 'default'}
                        variant={wf.enabled ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    <TableCell>
                      {wf.lastRun ? (
                        <Stack spacing={0.5} sx={{ minWidth: 150 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Chip
                              size="small"
                              label={runStatusLabel(wf.lastRun.status)}
                              color={runStatusColor(wf.lastRun.status)}
                              variant="outlined"
                            />
                            <Typography variant="caption" color="text.secondary">
                              {formatRelativeTime(wf.lastRun.finishedAt ?? wf.lastRun.createdAt)}
                            </Typography>
                          </Box>
                          <Typography variant="caption" color="text.secondary">
                            {formatCount(wf.lastRun.succeededCount)} ok
                            {wf.lastRun.failedCount > 0
                              ? ` · ${formatCount(wf.lastRun.failedCount)} failed`
                              : ''}
                            {wf.lastRun.skippedCount > 0
                              ? ` · ${formatCount(wf.lastRun.skippedCount)} skipped`
                              : ''}
                          </Typography>
                        </Stack>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          Never run
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{formatCount(wf.totals.matched)}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{formatCount(wf.totals.actioned)}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                        <Button
                          size="small"
                          startIcon={<HistoryIcon />}
                          onClick={() => onViewRuns(wf)}
                        >
                          Runs
                        </Button>
                        <Tooltip
                          title={
                            !canManage
                              ? 'Requires system_settings:write'
                              : !wf.enabled
                                ? 'Already disabled'
                                : 'Force-disable this workflow'
                          }
                        >
                          <span>
                            <Button
                              size="small"
                              color="error"
                              startIcon={<BlockIcon />}
                              disabled={!canManage || !wf.enabled}
                              onClick={() => onDisable(wf)}
                            >
                              Disable
                            </Button>
                          </span>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

        <TablePagination
          component="div"
          count={totalItems}
          page={page}
          onPageChange={(_, next) => onPageChange(next)}
          rowsPerPage={pageSize}
          onRowsPerPageChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
          rowsPerPageOptions={[10, 25, 50]}
        />
      </CardContent>
    </Card>
  );
}
