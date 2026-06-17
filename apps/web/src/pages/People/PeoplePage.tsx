import { useState, useEffect } from 'react';
import {
  Container,
  Box,
  Typography,
  Stack,
  Alert,
  Divider,
  Drawer,
  IconButton,
  TextField,
  CircularProgress,
  Grid,
  Button,
  Paper,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Close as CloseIcon,
  PhotoLibrary as PhotoLibraryIcon,
  Edit as EditIcon,
  Check as CheckIcon,
  Settings as SettingsIcon,
  Delete as DeleteIcon,
  CallMerge as CallMergeIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircleContext } from '../../contexts/CircleContext';
import { usePeople, usePerson } from '../../hooks/usePeople';
import { PersonGrid } from '../../components/people/PersonGrid';
import { UnknownFacesReview } from '../../components/people/UnknownFacesReview';
import { MergePeopleDialog } from '../../components/people/MergePeopleDialog';
import { FaceCrop } from '../../components/people/FaceCrop';
import type { PersonListItem } from '../../services/face';
import {
  getCircleFaceSettings,
  updateCircleFaceSettings,
  deleteCircleBiometrics,
  mergePeople,
  deletePerson,
} from '../../services/face';
import type { CircleFaceSettings } from '../../services/face';
import { listMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Delete Biometrics Dialog
// ---------------------------------------------------------------------------

interface DeleteBiometricsDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  onDeleted: (deletedFaces: number, deletedPeople: number) => void;
}

function DeleteBiometricsDialog({
  open,
  onClose,
  circleId,
  onDeleted,
}: DeleteBiometricsDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = confirmText === 'DELETE';

  const handleDelete = async () => {
    if (!canConfirm) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteCircleBiometrics(circleId);
      onDeleted(result.deletedFaces, result.deletedPeople);
      setConfirmText('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deletion failed. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    if (deleting) return;
    setConfirmText('');
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete All Biometric Data</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          This permanently deletes all face data, recognized people, and detection history for
          this circle. This cannot be undone. Face recognition will be disabled.
        </Typography>
        <Typography variant="body2" color="error" sx={{ mb: 2 }}>
          Type <strong>DELETE</strong> to confirm.
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
          autoFocus
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => void handleDelete()}
          disabled={!canConfirm || deleting}
          startIcon={deleting ? <CircularProgress size={16} /> : undefined}
        >
          {deleting ? 'Deleting…' : 'Delete All Biometric Data'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete Person Confirmation Dialog
// ---------------------------------------------------------------------------

interface DeletePersonDialogProps {
  open: boolean;
  personName: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

function DeletePersonDialog({ open, personName, onClose, onConfirm }: DeletePersonDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deletion failed. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    if (deleting) return;
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>Delete Person</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          Delete <strong>{personName ?? 'Unlabeled'}</strong>? Their photos will not be deleted,
          but face assignments will be cleared.
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => void handleConfirm()}
          disabled={deleting}
          startIcon={deleting ? <CircularProgress size={16} /> : undefined}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Person detail drawer content
// ---------------------------------------------------------------------------

function PersonDetailDrawer({
  personId,
  onClose,
  onRename,
  circleId,
  circleRole,
  allPeople,
  onPersonDeleted,
  onPersonMerged,
}: {
  personId: string;
  onClose: () => void;
  onRename: (personId: string, name: string) => Promise<void>;
  circleId: string;
  circleRole: string | null;
  allPeople: PersonListItem[];
  onPersonDeleted: () => void;
  onPersonMerged: () => void;
}) {
  const navigate = useNavigate();
  const { person, loading, error } = usePerson(personId);
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [mediaMap, setMediaMap] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

  const canManage = circleRole === 'circle_admin' || circleRole === 'collaborator';

  // When person loads, seed the name field
  useEffect(() => {
    if (person) setNameValue(person.name ?? '');
  }, [person]);

  // Fetch media URLs for face crops
  useEffect(() => {
    if (!person || person.faces.length === 0) return;
    listMedia({ personId: person.id, circleId, pageSize: 50 })
      .then((resp) => {
        const map: Record<string, string> = {};
        resp.items.forEach((m: MediaItem) => {
          if (m.thumbnailUrl) map[m.id] = m.thumbnailUrl;
        });
        setMediaMap(map);
      })
      .catch(() => undefined);
  }, [person, circleId]);

  const handleSave = async () => {
    if (!nameValue.trim() || !person) return;
    setSaving(true);
    try {
      await onRename(person.id, nameValue.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!person) return;
    await deletePerson(person.id);
    onPersonDeleted();
    onClose();
  };

  const handleMerge = async (targetId: string) => {
    if (!person) return;
    await mergePeople(person.id, targetId);
    onPersonMerged();
    onClose();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !person) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error ?? 'Person not found'}
      </Alert>
    );
  }

  // Build a PersonListItem-shaped object for the merge dialog source
  const personAsListItem: PersonListItem = {
    id: person.id,
    name: person.name,
    isUnlabeled: person.isUnlabeled,
    faceCount: person.faces.length,
    coverFace: person.coverFace,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };

  return (
    <Box sx={{ width: { xs: 320, sm: 400 }, p: 2 }}>
      {/* Header */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
        {editing ? (
          <>
            <TextField
              size="small"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="Enter name"
              autoFocus
              sx={{ flexGrow: 1 }}
            />
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || !nameValue.trim()}
            >
              {saving ? <CircularProgress size={16} /> : <CheckIcon />}
            </IconButton>
          </>
        ) : (
          <>
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              {person.name ?? 'Unlabeled'}
            </Typography>
            <IconButton size="small" onClick={() => setEditing(true)} aria-label="Edit name">
              <EditIcon fontSize="small" />
            </IconButton>
          </>
        )}

        {/* Merge action — admin/collaborator only */}
        {canManage && (
          <IconButton
            size="small"
            onClick={() => setMergeDialogOpen(true)}
            aria-label="Merge into another person"
            title="Merge into another person"
          >
            <CallMergeIcon fontSize="small" />
          </IconButton>
        )}

        {/* Delete action — admin/collaborator only */}
        {canManage && (
          <IconButton
            size="small"
            color="error"
            onClick={() => setDeleteDialogOpen(true)}
            aria-label="Delete person"
            title="Delete person"
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        )}

        <IconButton size="small" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </Stack>

      <Divider sx={{ mb: 2 }} />

      {/* View photos button */}
      <Button
        variant="contained"
        fullWidth
        startIcon={<PhotoLibraryIcon />}
        onClick={() =>
          navigate(
            `/media?personId=${person.id}&circleId=${circleId}&personName=${encodeURIComponent(person.name ?? 'Unknown')}`,
          )
        }
        sx={{ mb: 2 }}
      >
        View their photos ({person.faces.length})
      </Button>

      {/* Face crops */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Face samples
      </Typography>
      <Grid container spacing={1}>
        {person.faces.slice(0, 12).map((face) => {
          const imgUrl = mediaMap[face.mediaItemId];
          return (
            <Grid key={face.faceId}>
              {imgUrl ? (
                <FaceCrop imageUrl={imgUrl} boundingBox={face.boundingBox} size={72} />
              ) : (
                <Box sx={{ width: 72, height: 72, bgcolor: 'grey.200', borderRadius: 1 }} />
              )}
            </Grid>
          );
        })}
      </Grid>

      {/* Delete person confirmation dialog */}
      <DeletePersonDialog
        open={deleteDialogOpen}
        personName={person.name}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDelete}
      />

      {/* Merge people dialog */}
      <MergePeopleDialog
        open={mergeDialogOpen}
        onClose={() => setMergeDialogOpen(false)}
        sourcePerson={personAsListItem}
        people={allPeople}
        onMerge={handleMerge}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Face recognition opt-in gate (when disabled)
// ---------------------------------------------------------------------------

interface FaceOptInGateProps {
  circleRole: string | null;
  onEnable: () => void;
  enabling: boolean;
}

function FaceOptInGate({ circleRole, onEnable, enabling }: FaceOptInGateProps) {
  const isAdmin = circleRole === 'circle_admin';

  if (isAdmin) {
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', maxWidth: 480, mx: 'auto' }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Face Recognition is not enabled for this circle
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Face recognition uses biometric data (face embeddings) to identify people across your
          photos. This is opt-in per circle.
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={false}
              onChange={onEnable}
              disabled={enabling}
              color="primary"
            />
          }
          label={enabling ? 'Enabling…' : 'Enable face recognition'}
        />
      </Paper>
    );
  }

  return (
    <Alert severity="info">
      Face recognition is not enabled for this circle. Ask a circle admin to enable it.
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PeoplePage() {
  const { activeCircleId, activeCircleRole } = useCircleContext();
  const [selectedPerson, setSelectedPerson] = useState<PersonListItem | null>(null);

  // Face settings state
  const [faceSettings, setFaceSettings] = useState<CircleFaceSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [enablingFace, setEnablingFace] = useState(false);

  // Settings menu state
  const [settingsAnchorEl, setSettingsAnchorEl] = useState<null | HTMLElement>(null);
  const settingsMenuOpen = Boolean(settingsAnchorEl);

  // Delete biometrics dialog
  const [deleteBiometricsOpen, setDeleteBiometricsOpen] = useState(false);

  // Biometrics deletion result snackbar
  const [biometricsResult, setBiometricsResult] = useState<{
    deletedFaces: number;
    deletedPeople: number;
  } | null>(null);

  const canCluster =
    activeCircleRole === 'circle_admin' || activeCircleRole === 'collaborator';

  // Labeled people (name != null)
  const {
    data: labeledData,
    loading: labeledLoading,
    error: labeledError,
    refresh: refreshLabeled,
    rename,
    cluster,
  } = usePeople(activeCircleId, { includeUnlabeled: false });

  // Unlabeled people
  const {
    data: unlabeledData,
    loading: unlabeledLoading,
    error: unlabeledError,
    refresh: refreshUnlabeled,
  } = usePeople(activeCircleId, { includeUnlabeled: true });

  // Filter unlabeled from the unlabeled fetch
  const unlabeledPeople = (unlabeledData?.items ?? []).filter((p) => p.isUnlabeled);
  const labeledPeople = labeledData?.items ?? [];
  const allPeople = [...labeledPeople, ...unlabeledPeople];

  // Load face settings when circle changes
  useEffect(() => {
    if (!activeCircleId) {
      setFaceSettings(null);
      return;
    }
    setSettingsLoading(true);
    setSettingsError(null);
    getCircleFaceSettings(activeCircleId)
      .then(setFaceSettings)
      .catch((err) =>
        setSettingsError(err instanceof Error ? err.message : 'Failed to load face settings'),
      )
      .finally(() => setSettingsLoading(false));
  }, [activeCircleId]);

  const refreshFaceSettings = async () => {
    if (!activeCircleId) return;
    try {
      const settings = await getCircleFaceSettings(activeCircleId);
      setFaceSettings(settings);
    } catch {
      // ignore refresh errors
    }
  };

  const handleEnableFaceRecognition = async () => {
    if (!activeCircleId) return;
    setEnablingFace(true);
    try {
      const updated = await updateCircleFaceSettings(activeCircleId, true);
      setFaceSettings(updated);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : 'Failed to enable face recognition',
      );
    } finally {
      setEnablingFace(false);
    }
  };

  const handleDisableFaceRecognition = async () => {
    if (!activeCircleId) return;
    setSettingsAnchorEl(null);
    try {
      const updated = await updateCircleFaceSettings(activeCircleId, false);
      setFaceSettings(updated);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : 'Failed to disable face recognition',
      );
    }
  };

  const handleBiometricsDeleted = async (deletedFaces: number, deletedPeople: number) => {
    setBiometricsResult({ deletedFaces, deletedPeople });
    await Promise.all([refreshLabeled(), refreshUnlabeled(), refreshFaceSettings()]);
  };

  const handlePersonClick = (person: PersonListItem) => {
    setSelectedPerson(person);
  };

  const handleCluster = async () => {
    const result = await cluster();
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
    return result;
  };

  const handleRename = async (personId: string, name: string) => {
    await rename(personId, name);
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
  };

  const handlePersonDeleted = async () => {
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
  };

  const handlePersonMerged = async () => {
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
  };

  if (!activeCircleId) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Alert severity="info">Select a circle to view people.</Alert>
      </Container>
    );
  }

  // While loading face settings, show a spinner
  if (settingsLoading) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      </Container>
    );
  }

  // Settings load error
  if (settingsError && !faceSettings) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Alert severity="error">{settingsError}</Alert>
      </Container>
    );
  }

  // Opt-in gate — face recognition not enabled
  if (faceSettings && !faceSettings.faceRecognitionEnabled) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack direction="row" sx={{ mb: 3, alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h4">People</Typography>
        </Stack>
        <FaceOptInGate
          circleRole={activeCircleRole}
          onEnable={() => void handleEnableFaceRecognition()}
          enabling={enablingFace}
        />
      </Container>
    );
  }

  // Normal People UI (face recognition enabled)
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {/* Header */}
      <Stack direction="row" sx={{ mb: 3, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h4">People</Typography>

        {/* Settings menu — circle_admin only, when face recognition is enabled */}
        {activeCircleRole === 'circle_admin' && faceSettings?.faceRecognitionEnabled && (
          <>
            <IconButton
              onClick={(e) => setSettingsAnchorEl(e.currentTarget)}
              aria-label="Face recognition settings"
              aria-controls={settingsMenuOpen ? 'face-settings-menu' : undefined}
              aria-haspopup="true"
              aria-expanded={settingsMenuOpen ? 'true' : undefined}
            >
              <SettingsIcon />
            </IconButton>
            <Menu
              id="face-settings-menu"
              anchorEl={settingsAnchorEl}
              open={settingsMenuOpen}
              onClose={() => setSettingsAnchorEl(null)}
            >
              <MenuItem onClick={() => void handleDisableFaceRecognition()}>
                Disable face recognition
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setSettingsAnchorEl(null);
                  setDeleteBiometricsOpen(true);
                }}
                sx={{ color: 'error.main' }}
              >
                Delete all biometrics (GDPR erase)…
              </MenuItem>
            </Menu>
          </>
        )}
      </Stack>

      {settingsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {settingsError}
        </Alert>
      )}

      {biometricsResult && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setBiometricsResult(null)}
        >
          Deleted {biometricsResult.deletedFaces} face records and{' '}
          {biometricsResult.deletedPeople} people.
        </Alert>
      )}

      {(labeledError || unlabeledError) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {labeledError ?? unlabeledError}
        </Alert>
      )}

      {/* Labeled people section */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Named People ({labeledPeople.length})
        </Typography>
        <PersonGrid
          people={labeledPeople}
          onPersonClick={handlePersonClick}
          loading={labeledLoading}
          emptyMessage="No named people yet. Use 'Find People' then name the clusters below."
        />
      </Box>

      <Divider sx={{ mb: 3 }} />

      {/* Unknown faces section */}
      <UnknownFacesReview
        unlabeledPeople={unlabeledPeople}
        onPersonClick={handlePersonClick}
        onCluster={handleCluster}
        onRename={handleRename}
        canCluster={canCluster}
        loading={unlabeledLoading}
      />

      {/* Person detail drawer */}
      <Drawer
        anchor="right"
        open={selectedPerson !== null}
        onClose={() => setSelectedPerson(null)}
        ModalProps={{ keepMounted: false }}
      >
        {selectedPerson && activeCircleId && (
          <PersonDetailDrawer
            personId={selectedPerson.id}
            onClose={() => setSelectedPerson(null)}
            onRename={handleRename}
            circleId={activeCircleId}
            circleRole={activeCircleRole}
            allPeople={allPeople}
            onPersonDeleted={() => void handlePersonDeleted()}
            onPersonMerged={() => void handlePersonMerged()}
          />
        )}
      </Drawer>

      {/* Delete biometrics dialog */}
      {activeCircleId && (
        <DeleteBiometricsDialog
          open={deleteBiometricsOpen}
          onClose={() => setDeleteBiometricsOpen(false)}
          circleId={activeCircleId}
          onDeleted={handleBiometricsDeleted}
        />
      )}
    </Container>
  );
}
