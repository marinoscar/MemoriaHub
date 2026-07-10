import { useState } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  IconButton,
  FormControlLabel,
  Switch,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Link,
} from '@mui/material';
import {
  Hub as HubIcon,
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
  CheckCircle as HealthyIcon,
  Warning as StaleIcon,
  Cancel as OfflineIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkers } from '../../hooks/useWorkers';
import type { WorkerNodeDto, NodeStatus, NodeHealth } from '../../services/workers';
import { relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<NodeStatus, 'default' | 'success' | 'warning' | 'error'> = {
  online: 'success',
  draining: 'warning',
  offline: 'default',
  disabled: 'error',
};

function StatusChip({ status }: { status: NodeStatus }) {
  return (
    <Chip
      label={status}
      color={STATUS_COLORS[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

const HEALTH_META: Record<
  NodeHealth,
  { color: 'success' | 'warning' | 'error'; label: string; Icon: typeof HealthyIcon }
> = {
  healthy: { color: 'success', label: 'Healthy', Icon: HealthyIcon },
  stale: { color: 'warning', label: 'Stale', Icon: StaleIcon },
  offline: { color: 'error', label: 'Offline', Icon: OfflineIcon },
};

/** Heartbeat-freshness pill driven by the server-derived `health` field. */
function HeartbeatPill({ node }: { node: WorkerNodeDto }) {
  const meta = HEALTH_META[node.health] ?? HEALTH_META.offline;
  const rel = node.lastHeartbeatAt ? relativeTime(node.lastHeartbeatAt) : 'never';
  return (
    <Tooltip
      title={
        node.lastHeartbeatAt
          ? `Last heartbeat ${new Date(node.lastHeartbeatAt).toLocaleString()}`
          : 'No heartbeat recorded'
      }
      arrow
    >
      <Chip
        icon={<meta.Icon />}
        label={`${meta.label} · ${rel}`}
        color={meta.color}
        size="small"
        variant="outlined"
        sx={{ cursor: 'help' }}
      />
    </Tooltip>
  );
}

const MAX_TYPE_CHIPS = 3;

/** Renders eligible job types as small chips, truncating with a "+N" overflow chip. */
function EligibleTypes({ types }: { types: string[] }) {
  if (!types || types.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  const shown = types.slice(0, MAX_TYPE_CHIPS);
  const overflow = types.length - shown.length;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {shown.map((t) => (
        <Chip key={t} label={t} size="small" variant="outlined" />
      ))}
      {overflow > 0 && (
        <Tooltip title={types.slice(MAX_TYPE_CHIPS).join(', ')} arrow>
          <Chip label={`+${overflow}`} size="small" variant="outlined" sx={{ cursor: 'help' }} />
        </Tooltip>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Confirm delete dialog
// ---------------------------------------------------------------------------

interface ConfirmDeleteDialogProps {
  open: boolean;
  node: WorkerNodeDto;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteDialog({ open, node, onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Deregister worker node?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Node <strong>{node.name}</strong> ({node.hostname}) will be removed from the fleet. Any
          jobs it currently holds are released back to the queue. This cannot be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onConfirm} color="error" variant="contained">
          Deregister
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function WorkersPageContent() {
  const { nodes, loading, error, autoRefresh, setAutoRefresh, refresh, deleteWorker } = useWorkers({
    autoRefresh: true,
  });

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<WorkerNodeDto | null>(null);
  const [mutating, setMutating] = useState(false);

  const handleDelete = async () => {
    if (!deleteDialog) return;
    const node = deleteDialog;
    setDeleteDialog(null);
    setMutating(true);
    try {
      await deleteWorker(node.id);
      setSuccessMessage(`Node "${node.name}" deregistered`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to deregister node');
    } finally {
      setMutating(false);
    }
  };

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <HubIcon color="primary" />
          <Typography variant="h4" component="h1">
            Worker Nodes
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Distributed CLI worker nodes: fleet health, heartbeats, and per-node job stats.
          Auto-refreshes every 5 seconds.
        </Typography>

        {/* Action bar */}
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ flexWrap: 'wrap', alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              disabled={loading}
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

        {/* Error */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Nodes table */}
        <Paper variant="outlined">
          {loading && nodes.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Node</TableCell>
                    <TableCell>Platform</TableCell>
                    <TableCell>CLI Version</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Heartbeat</TableCell>
                    <TableCell>Eligible Types</TableCell>
                    <TableCell align="center">Concurrency</TableCell>
                    <TableCell align="center">Running</TableCell>
                    <TableCell align="center">Succeeded</TableCell>
                    <TableCell align="center">Failed</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {nodes.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={11}
                        align="center"
                        sx={{ py: 4, color: 'text.secondary' }}
                      >
                        No worker nodes registered
                      </TableCell>
                    </TableRow>
                  ) : (
                    nodes.map((node) => (
                      <TableRow key={node.id} hover>
                        <TableCell sx={{ maxWidth: 220 }}>
                          <Typography variant="body2" noWrap>
                            {node.name}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ color: 'text.secondary', display: 'block' }}
                            noWrap
                          >
                            {node.hostname}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {node.platform}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {node.cliVersion}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <StatusChip status={node.status} />
                        </TableCell>
                        <TableCell>
                          <HeartbeatPill node={node} />
                        </TableCell>
                        <TableCell sx={{ maxWidth: 240 }}>
                          <EligibleTypes types={node.eligibleTypes} />
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2">{node.concurrency}</Typography>
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2" color="info.main">
                            {node.jobCounts.running}
                          </Typography>
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2" color="success.main">
                            {node.jobCounts.succeeded}
                          </Typography>
                        </TableCell>
                        <TableCell align="center">
                          <Typography
                            variant="body2"
                            color={node.jobCounts.failed > 0 ? 'error.main' : 'text.secondary'}
                          >
                            {node.jobCounts.failed}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Deregister node">
                            <span>
                              <IconButton
                                size="small"
                                aria-label="Deregister node"
                                color="error"
                                disabled={mutating}
                                onClick={() => setDeleteDialog(node)}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Box>

      {/* Confirm delete dialog */}
      {deleteDialog && (
        <ConfirmDeleteDialog
          open
          node={deleteDialog}
          onConfirm={() => void handleDelete()}
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
// Admin-gated export (mirrors JobsPage pattern)
// ---------------------------------------------------------------------------

export default function WorkersPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <WorkersPageContent />;
}
