/**
 * A phone's sync runs, newest first (issue #515), paged ten at a time. A table
 * from `sm` up; below it a list, so a 360 px phone never scrolls sideways.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  List,
  ListItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { MediaSyncRun } from '../../../services/mediaSync';
import { formatBytes } from '../../../utils/formatBytes';
import { RunStatusChip } from './RunStatusChip';
import { TRIGGER_LABELS, formatDateTime } from './format';

const PAGE_SIZE = 10;

function bytes(run: MediaSyncRun): string {
  return /^\d+$/.test(run.bytesUploaded) ? formatBytes(run.bytesUploaded) : run.bytesUploaded;
}

interface SyncHistoryProps {
  runs: MediaSyncRun[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function SyncHistory({ runs, isLoading, error, onRetry }: SyncHistoryProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const [page, setPage] = useState(0);

  if (isLoading && runs.length === 0) {
    return (
      <Box data-testid="sync-history-loading">
        <Skeleton width="80%" />
        <Skeleton width="60%" />
      </Box>
    );
  }
  if (error && runs.length === 0) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }
  if (runs.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No syncs yet. The phone reports every sync here, including failed ones.
      </Typography>
    );
  }

  const visible = runs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pager = (
    <TablePagination
      component="div"
      count={runs.length}
      page={Math.min(page, Math.max(0, Math.ceil(runs.length / PAGE_SIZE) - 1))}
      onPageChange={(_, p) => setPage(p)}
      rowsPerPage={PAGE_SIZE}
      rowsPerPageOptions={[PAGE_SIZE]}
    />
  );

  if (isCompactWindow) {
    return (
      <Box>
        <List dense disablePadding aria-label="Sync history">
          {visible.map((run) => (
            <ListItem key={run.id} divider disableGutters sx={{ display: 'block' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {formatDateTime(run.finishedAt)}
                </Typography>
                <RunStatusChip status={run.status} />
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {TRIGGER_LABELS[run.trigger] ?? run.trigger} · {run.filesUploaded} uploaded · {run.filesFailed} failed ·{' '}
                {run.filesDeduplicated} already there · {bytes(run)}
              </Typography>
              {run.errorCode && (
                <Typography variant="caption" color="error" sx={{ overflowWrap: 'anywhere' }}>
                  {run.errorCode}
                </Typography>
              )}
            </ListItem>
          ))}
        </List>
        {pager}
      </Box>
    );
  }

  return (
    <Box>
      <TableContainer>
        <Table size="small" aria-label="Sync history">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Trigger</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Uploaded</TableCell>
              <TableCell align="right">Failed</TableCell>
              <TableCell align="right">Already there</TableCell>
              <TableCell align="right">Bytes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{formatDateTime(run.finishedAt)}</TableCell>
                <TableCell>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                    <RunStatusChip status={run.status} />
                    {run.errorCode && (
                      <Typography variant="caption" color="error">
                        {run.errorCode}
                      </Typography>
                    )}
                  </Box>
                </TableCell>
                <TableCell align="right">{run.filesUploaded}</TableCell>
                <TableCell align="right">{run.filesFailed}</TableCell>
                <TableCell align="right">{run.filesDeduplicated}</TableCell>
                <TableCell align="right">{bytes(run)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {pager}
    </Box>
  );
}
