import { useState, FormEvent } from 'react';
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
  TextField,
  RadioGroup,
  Radio,
  FormControl,
  FormLabel,
  InputAdornment,
} from '@mui/material';
import {
  Hub as HubIcon,
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
  CheckCircle as HealthyIcon,
  Warning as StaleIcon,
  Cancel as OfflineIcon,
  Add as AddIcon,
  ContentCopy as ContentCopyIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkers } from '../../hooks/useWorkers';
import { useNodeCredentials } from '../../hooks/useNodeCredentials';
import type { WorkerNodeDto, NodeStatus, NodeHealth } from '../../services/workers';
import type {
  AdminNodeCredentialDto,
  CreatedNodeCredentialDto,
} from '../../services/workers';
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
// Confirm revoke credential dialog
// ---------------------------------------------------------------------------

interface ConfirmRevokeCredentialDialogProps {
  open: boolean;
  credential: AdminNodeCredentialDto;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmRevokeCredentialDialog({
  open,
  credential,
  onConfirm,
  onCancel,
}: ConfirmRevokeCredentialDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Revoke credential?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Revoking is immediate. The worker using token{' '}
          <strong>{credential.tokenPrefix}…</strong> (named <strong>{credential.name}</strong>)
          will lose access right away. This cannot be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onConfirm} color="error" variant="contained">
          Revoke
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create node credential dialog
// ---------------------------------------------------------------------------

type CredentialExpiryOption = 'never' | 'custom';

interface CreateNodeCredentialDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: CreatedNodeCredentialDto) => void;
  onCreate: (data: { name: string; expiresAt: string | null }) => Promise<CreatedNodeCredentialDto>;
}

function CreateNodeCredentialDialog({
  open,
  onClose,
  onCreated,
  onCreate,
}: CreateNodeCredentialDialogProps) {
  const [name, setName] = useState('');
  const [expiryOption, setExpiryOption] = useState<CredentialExpiryOption>('never');
  const [customDate, setCustomDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setName('');
    setExpiryOption('never');
    setCustomDate('');
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (expiryOption === 'custom' && !customDate) {
      setError('Please choose an expiration date');
      return;
    }

    setIsSubmitting(true);
    try {
      const expiresAt =
        expiryOption === 'custom' ? new Date(customDate).toISOString() : null;
      const response = await onCreate({ name: name.trim(), expiresAt });
      resetForm();
      onCreated(response);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create credential');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      resetForm();
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Create node credential</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            <TextField
              label="Name"
              fullWidth
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              sx={{ mb: 2 }}
              placeholder="e.g. VPS worker 1"
            />
            <FormControl component="fieldset" disabled={isSubmitting}>
              <FormLabel component="legend" id="credential-expiry-label">
                Expiry
              </FormLabel>
              <RadioGroup
                aria-labelledby="credential-expiry-label"
                value={expiryOption}
                onChange={(e) => setExpiryOption(e.target.value as CredentialExpiryOption)}
              >
                <FormControlLabel value="never" control={<Radio />} label="Never expires" />
                <FormControlLabel value="custom" control={<Radio />} label="Expires on…" />
              </RadioGroup>
            </FormControl>
            {expiryOption === 'custom' && (
              <TextField
                label="Expiration date"
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                disabled={isSubmitting}
                sx={{ mt: 1 }}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={
              isSubmitting || !name.trim() || (expiryOption === 'custom' && !customDate)
            }
          >
            {isSubmitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Node credential reveal dialog
// ---------------------------------------------------------------------------

interface NodeCredentialRevealDialogProps {
  open: boolean;
  onClose: () => void;
  token: string | null;
}

function NodeCredentialRevealDialog({ open, onClose, token }: NodeCredentialRevealDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback: do nothing if clipboard access is denied
    }
  };

  const handleClose = () => {
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Node Credential Created</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This token will not be shown again. Store it as <code>MEMORIAHUB_TOKEN</code> on
            your worker.
          </Alert>
          <TextField
            label="Your Token"
            value={token || ''}
            fullWidth
            slotProps={{
              input: {
                readOnly: true,
                sx: { fontFamily: 'monospace' },
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title={copied ? 'Copied!' : 'Copy token'}>
                      <IconButton onClick={() => void handleCopy()} edge="end" aria-label="Copy token">
                        {copied ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              },
            }}
          />
          {copied && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Token copied to clipboard!
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={handleClose}>
          Done
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
  const {
    credentials,
    loading: credentialsLoading,
    error: credentialsError,
    createCredential,
    revokeCredential,
  } = useNodeCredentials();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<WorkerNodeDto | null>(null);
  const [mutating, setMutating] = useState(false);

  const [credentialMutating, setCredentialMutating] = useState(false);
  const [createCredentialDialogOpen, setCreateCredentialDialogOpen] = useState(false);
  const [revokeCredentialDialog, setRevokeCredentialDialog] =
    useState<AdminNodeCredentialDto | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

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

  const handleCredentialCreated = (created: CreatedNodeCredentialDto) => {
    setSuccessMessage(`Credential "${created.name}" created`);
    setRevealedToken(created.token);
  };

  const handleRevokeCredential = async () => {
    if (!revokeCredentialDialog) return;
    const credential = revokeCredentialDialog;
    setRevokeCredentialDialog(null);
    setCredentialMutating(true);
    try {
      await revokeCredential(credential.id);
      setSuccessMessage(`Credential "${credential.name}" revoked`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to revoke credential');
    } finally {
      setCredentialMutating(false);
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

        {/* Node credentials section */}
        <Box sx={{ mt: 5 }}>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: { xs: 'flex-start', sm: 'center' },
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 1,
              mb: 1,
            }}
          >
            <Box>
              <Typography variant="h5" component="h2">
                Node credentials
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Durable tokens (prefix <code>nod_</code>) used by containerized worker nodes —
                set as the <code>MEMORIAHUB_TOKEN</code> environment variable. Least-privilege:
                valid only for node endpoints.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setCreateCredentialDialogOpen(true)}
            >
              Create credential
            </Button>
          </Box>

          {credentialsError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {credentialsError}
            </Alert>
          )}

          <Paper variant="outlined">
            {credentialsLoading && credentials.length === 0 ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={28} />
              </Box>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Prefix</TableCell>
                      <TableCell>Owner</TableCell>
                      <TableCell>Created</TableCell>
                      <TableCell>Last used</TableCell>
                      <TableCell>Expires</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {credentials.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                          No node credentials yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      credentials.map((cred) => {
                        const isExpired =
                          !!cred.expiresAt && new Date(cred.expiresAt) < new Date();
                        const isRevoked = !!cred.revokedAt;
                        return (
                          <TableRow key={cred.id} hover>
                            <TableCell sx={{ maxWidth: 220 }}>
                              <Typography variant="body2" noWrap>
                                {cred.name}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                                {cred.tokenPrefix}…
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2" color="text.secondary" noWrap>
                                {cred.ownerEmail}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2" color="text.secondary" noWrap>
                                {relativeTime(cred.createdAt)}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2" color="text.secondary" noWrap>
                                {cred.lastUsedAt ? relativeTime(cred.lastUsedAt) : '—'}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              {cred.expiresAt ? (
                                <Typography
                                  variant="body2"
                                  color={isExpired ? 'error.main' : 'text.secondary'}
                                  noWrap
                                >
                                  {new Date(cred.expiresAt).toLocaleDateString()}
                                </Typography>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  Never
                                </Typography>
                              )}
                            </TableCell>
                            <TableCell>
                              <Chip
                                label={isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Active'}
                                color={isRevoked ? 'default' : isExpired ? 'warning' : 'success'}
                                size="small"
                                variant="outlined"
                              />
                            </TableCell>
                            <TableCell align="right">
                              {!isRevoked && (
                                <Tooltip title="Revoke credential">
                                  <span>
                                    <IconButton
                                      size="small"
                                      aria-label="Revoke credential"
                                      color="error"
                                      disabled={credentialMutating}
                                      onClick={() => setRevokeCredentialDialog(cred)}
                                    >
                                      <DeleteIcon fontSize="small" />
                                    </IconButton>
                                  </span>
                                </Tooltip>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Box>
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

      {/* Confirm revoke credential dialog */}
      {revokeCredentialDialog && (
        <ConfirmRevokeCredentialDialog
          open
          credential={revokeCredentialDialog}
          onConfirm={() => void handleRevokeCredential()}
          onCancel={() => setRevokeCredentialDialog(null)}
        />
      )}

      {/* Create node credential dialog */}
      <CreateNodeCredentialDialog
        open={createCredentialDialogOpen}
        onClose={() => setCreateCredentialDialogOpen(false)}
        onCreated={handleCredentialCreated}
        onCreate={createCredential}
      />

      {/* Node credential reveal dialog */}
      <NodeCredentialRevealDialog
        open={!!revealedToken}
        onClose={() => setRevealedToken(null)}
        token={revealedToken}
      />

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
