import { useState, useEffect, useCallback } from 'react';
import {
  Container,
  Typography,
  Box,
  Button,
  Card,
  CardContent,
  CardActions,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  CircularProgress,
  Alert,
  Chip,
} from '@mui/material';
import {
  Add as AddIcon,
  GroupWork as CircleIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircles } from '../../hooks/useCircles';
import { useCircleContext } from '../../contexts/CircleContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../contexts/AuthContext';
import type { Circle } from '../../types/circles';

export default function CircleListPage() {
  const navigate = useNavigate();
  const { circles, loading, error, fetchCircles, addCircle, editCircle, removeCircle } =
    useCircles();
  const { refreshCircles, activeCircleId } = useCircleContext();
  const { isAdmin } = usePermissions();
  const { user } = useAuth();

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog state (single shared dialog, target held in `editing`)
  const [editing, setEditing] = useState<Circle | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation dialog state
  const [deleting, setDeleting] = useState<Circle | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void fetchCircles();
  }, [fetchCircles]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await addCircle({
        name: createName.trim(),
        description: createDescription.trim() || undefined,
      });
      await refreshCircles();
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create circle');
    } finally {
      setCreating(false);
    }
  }, [createName, createDescription, addCircle, refreshCircles]);

  const handleDialogClose = useCallback(() => {
    if (creating) return;
    setCreateOpen(false);
    setCreateName('');
    setCreateDescription('');
    setCreateError(null);
  }, [creating]);

  const handleEditOpen = useCallback((circle: Circle) => {
    setEditing(circle);
    setEditName(circle.name);
    setEditDescription(circle.description ?? '');
    setEditError(null);
  }, []);

  const handleEditClose = useCallback(() => {
    if (saving) return;
    setEditing(null);
    setEditName('');
    setEditDescription('');
    setEditError(null);
  }, [saving]);

  const handleEditSave = useCallback(async () => {
    if (!editing || !editName.trim()) return;
    setSaving(true);
    setEditError(null);
    try {
      await editCircle(editing.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      });
      await refreshCircles();
      await fetchCircles();
      setEditing(null);
      setEditName('');
      setEditDescription('');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update circle');
    } finally {
      setSaving(false);
    }
  }, [editing, editName, editDescription, editCircle, refreshCircles, fetchCircles]);

  const handleDeleteClose = useCallback(() => {
    if (deleteBusy) return;
    setDeleting(null);
    setDeleteError(null);
  }, [deleteBusy]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await removeCircle(deleting.id);
      await refreshCircles();
      await fetchCircles();
      setDeleting(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete circle');
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, removeCircle, refreshCircles, fetchCircles]);

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
        }}
      >
        <Typography variant="h5" component="h1">
          My Circles
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateOpen(true)}
        >
          Create Circle
        </Button>
      </Box>

      {/* Error */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Loading */}
      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {!loading && circles.length === 0 && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <CircleIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            No circles yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Create a circle to start organising your family media.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            Create your first circle
          </Button>
        </Box>
      )}

      {/* Circle grid */}
      {!loading && circles.length > 0 && (
        <Grid container spacing={2}>
          {circles.map((circle) => {
            const canManage = isAdmin || circle.ownerId === user?.id;
            return (
            <Grid key={circle.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <CardContent sx={{ flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Typography variant="h6" component="div" noWrap sx={{ flex: 1 }}>
                      {circle.name}
                    </Typography>
                    {circle.id === activeCircleId && (
                      <Chip label="Active" size="small" color="success" />
                    )}
                    {circle.isPersonal && (
                      <Chip label="Personal" size="small" color="primary" variant="outlined" />
                    )}
                  </Box>
                  {circle.description && (
                    <Typography variant="body2" color="text.secondary">
                      {circle.description}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Created {new Date(circle.createdAt).toLocaleDateString()}
                  </Typography>
                </CardContent>
                <CardActions>
                  <Button size="small" onClick={() => navigate(`/circles/${circle.id}`)}>
                    View
                  </Button>
                  {canManage && (
                    <Button
                      size="small"
                      startIcon={<EditIcon />}
                      onClick={() => handleEditOpen(circle)}
                    >
                      Edit
                    </Button>
                  )}
                  {canManage && !circle.isPersonal && (
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteIcon />}
                      onClick={() => setDeleting(circle)}
                    >
                      Delete
                    </Button>
                  )}
                </CardActions>
              </Card>
            </Grid>
            );
          })}
        </Grid>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={handleDialogClose} maxWidth="sm" fullWidth>
        <DialogTitle>Create Circle</DialogTitle>
        <DialogContent>
          {createError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {createError}
            </Alert>
          )}
          <TextField
            autoFocus
            label="Circle name"
            fullWidth
            required
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !creating) void handleCreate();
            }}
          />
          <TextField
            label="Description (optional)"
            fullWidth
            multiline
            rows={3}
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDialogClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreate()}
            disabled={creating || !createName.trim()}
            startIcon={creating ? <CircularProgress size={16} /> : undefined}
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onClose={handleEditClose} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Circle</DialogTitle>
        <DialogContent>
          {editError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {editError}
            </Alert>
          )}
          <TextField
            autoFocus
            label="Circle name"
            fullWidth
            required
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !saving) void handleEditSave();
            }}
          />
          <TextField
            label="Description (optional)"
            fullWidth
            multiline
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleEditClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleEditSave()}
            disabled={saving || !editName.trim()}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleting !== null} onClose={handleDeleteClose} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Circle</DialogTitle>
        <DialogContent>
          {deleteError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {deleteError}
            </Alert>
          )}
          <Typography variant="body2">
            Are you sure you want to delete{' '}
            <strong>{deleting?.name}</strong>? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteClose} disabled={deleteBusy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleDeleteConfirm()}
            disabled={deleteBusy}
            startIcon={deleteBusy ? <CircularProgress size={16} /> : undefined}
          >
            {deleteBusy ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
