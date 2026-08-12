/**
 * Admin → Worker Nodes (`/admin/settings/nodes`).
 *
 * Migrated onto the shared DataTable in issue #259 (epic #238). Two hand-rolled
 * tables went away here — an eleven-column fleet table and an eight-column node
 * credentials table, both of which could only be read by scrolling the document
 * sideways on anything narrower than a laptop, and both of which put their only
 * destructive action (deregister / revoke) in the last column, i.e. the first
 * thing to fall off a phone.
 *
 * Both are now `DataTableColumn[]` declarations in `./workersTable.tsx`, with
 * `status` as a `primary` column so a card leads with "is this node up?"
 * (issue #259's decision). Their two bespoke confirm dialogs are gone too: a
 * row action's own `confirm` gives the same copy from one implementation.
 *
 * ## The auto-refresh contract
 *
 * `useWorkers` polls every 5 seconds, so both tables are rendered
 * UNCONDITIONALLY with `loading` passed as a prop. Gating the render on
 * `loading` would remount the renderer twelve times a minute and take its
 * expansion state and the page's scroll offset with it
 * (docs/specs/datatable.md §18.4).
 */

import { useCallback, useMemo, useState, FormEvent } from 'react';
import { Navigate, Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  Button,
  Alert,
  Snackbar,
  Tooltip,
  IconButton,
  FormControlLabel,
  Switch,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Link,
  TextField,
  RadioGroup,
  Radio,
  FormControl,
  FormLabel,
  InputAdornment,
} from '@mui/material';
import HubIcon from '@mui/icons-material/Hub';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import BackupSettingsIcon from '@mui/icons-material/SettingsBackupRestore';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkers } from '../../hooks/useWorkers';
import { useNodeCredentials } from '../../hooks/useNodeCredentials';
import type { WorkerNodeDto } from '../../services/workers';
import type {
  AdminNodeCredentialDto,
  CreatedNodeCredentialDto,
} from '../../services/workers';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  NODE_CREDENTIALS_TABLE_ID,
  WORKER_NODES_TABLE_ID,
  buildNodeCredentialColumns,
  buildWorkerNodeColumns,
  isCredentialRevoked,
} from './workersTable';

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
  const navigate = useNavigate();
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
  const [mutating, setMutating] = useState(false);

  const [credentialMutating, setCredentialMutating] = useState(false);
  const [createCredentialDialogOpen, setCreateCredentialDialogOpen] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const handleDelete = useCallback(
    async (node: WorkerNodeDto) => {
      setMutating(true);
      try {
        await deleteWorker(node.id);
        setSuccessMessage(`Node "${node.name}" deregistered`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to deregister node');
      } finally {
        setMutating(false);
      }
    },
    [deleteWorker],
  );

  const handleCredentialCreated = (created: CreatedNodeCredentialDto) => {
    setSuccessMessage(`Credential "${created.name}" created`);
    setRevealedToken(created.token);
  };

  const handleRevokeCredential = useCallback(
    async (credential: AdminNodeCredentialDto) => {
      setCredentialMutating(true);
      try {
        await revokeCredential(credential.id);
        setSuccessMessage(`Credential "${credential.name}" revoked`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to revoke credential');
      } finally {
        setCredentialMutating(false);
      }
    },
    [revokeCredential],
  );

  // --- Columns + row actions -------------------------------------------------

  const nodeColumns = useMemo(() => buildWorkerNodeColumns(), []);
  const credentialColumns = useMemo(() => buildNodeCredentialColumns(), []);

  const nodeActions = useMemo<DataTableRowAction<WorkerNodeDto>[]>(
    () => [
      {
        id: 'backup-settings',
        label: 'Backup settings',
        icon: <BackupSettingsIcon fontSize="small" />,
        onClick: (node) => navigate(`/admin/settings/nodes/${node.id}/backup`),
      },
      {
        id: 'deregister',
        label: 'Deregister node',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        disabled: () => mutating,
        confirm: {
          title: 'Deregister worker node?',
          description: (node) =>
            `Node ${node.name} (${node.hostname}) will be removed from the fleet. Any jobs it currently holds are released back to the queue. This cannot be undone.`,
          confirmLabel: 'Deregister',
        },
        onClick: (node) => void handleDelete(node),
      },
    ],
    [mutating, handleDelete],
  );

  const credentialActions = useMemo<DataTableRowAction<AdminNodeCredentialDto>[]>(
    () => [
      {
        id: 'revoke',
        label: 'Revoke credential',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // An already-revoked credential has nothing left to revoke; the old
        // table hid the button entirely, which is unreachable-by-keyboard
        // equivalent to disabling it — the DataTable keeps the control present
        // with its tooltip and marks it disabled instead.
        disabled: (credential) => credentialMutating || isCredentialRevoked(credential),
        confirm: {
          title: 'Revoke credential?',
          description: (credential) =>
            `Revoking is immediate. The worker using token ${credential.tokenPrefix}… (named ${credential.name}) will lose access right away. This cannot be undone.`,
          confirmLabel: 'Revoke',
        },
        onClick: (credential) => void handleRevokeCredential(credential),
      },
    ],
    [credentialMutating, handleRevokeCredential],
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

        {/* Nodes table */}
        <DataTable<WorkerNodeDto>
          columns={nodeColumns}
          rows={nodes}
          rowId={(node) => node.id}
          tableId={WORKER_NODES_TABLE_ID}
          ariaLabel="Worker nodes"
          density="compact"
          loading={loading}
          error={error}
          emptyState={<span>No worker nodes registered</span>}
          rowActions={nodeActions}
          csvExport={{ filename: 'worker-nodes' }}
        />

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

          <DataTable<AdminNodeCredentialDto>
            columns={credentialColumns}
            rows={credentials}
            rowId={(credential) => credential.id}
            tableId={NODE_CREDENTIALS_TABLE_ID}
            ariaLabel="Node credentials"
            density="compact"
            loading={credentialsLoading}
            error={credentialsError}
            emptyState={<span>No node credentials yet</span>}
            rowActions={credentialActions}
            csvExport={{ filename: 'node-credentials' }}
          />
        </Box>
      </Box>

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
