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
  Checkbox,
  Autocomplete,
  Tooltip,
  Snackbar,
  Tab,
  Tabs,
  Badge,
  Collapse,
} from '@mui/material';
import {
  Close as CloseIcon,
  PhotoLibrary as PhotoLibraryIcon,
  Edit as EditIcon,
  Check as CheckIcon,
  Settings as SettingsIcon,
  Delete as DeleteIcon,
  CallMerge as CallMergeIcon,
  PhotoCamera as PhotoCameraIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  ImageSearch as ImageSearchIcon,
  VisibilityOff as VisibilityOffIcon,
  Visibility as VisibilityIcon,
  SelectAll as SelectAllIcon,
  Restore as RestoreIcon,
  DeleteForever as DeleteForeverIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import { useCircleContext } from '../../contexts/CircleContext';
import { usePeople, usePerson } from '../../hooks/usePeople';
import { PersonGrid } from '../../components/people/PersonGrid';
import { UnknownFacesReview } from '../../components/people/UnknownFacesReview';
import { MergePeopleDialog } from '../../components/people/MergePeopleDialog';
import { FaceCrop } from '../../components/people/FaceCrop';
import { PersonAvatar } from '../../components/people/PersonAvatar';
import type { PersonListItem, PersonDetail, UnassignedFaceDto } from '../../services/face';
import {
  deleteCircleBiometrics,
  mergePeople,
  deletePerson,
  assignFaces as assignFacesService,
  createPerson as createPersonService,
  updatePerson,
  setPersonFavorite,
} from '../../services/face';
import { listMedia, getMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';

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
// Purge (permanent delete) Confirmation Dialog
// ---------------------------------------------------------------------------

interface PurgePeopleDialogProps {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

function PurgePeopleDialog({ open, count, onClose, onConfirm }: PurgePeopleDialogProps) {
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
      <DialogTitle>Delete permanently?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          This permanently removes{' '}
          <strong>
            {count} person record{count !== 1 ? 's' : ''}
          </strong>{' '}
          and their face data. <strong>Your photos are NOT deleted.</strong> This cannot be undone.
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
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Purge Faces Dialog (permanent delete of individual archived faces)
// ---------------------------------------------------------------------------

interface PurgeFacesDialogProps {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

function PurgeFacesDialog({ open, count, onClose, onConfirm }: PurgeFacesDialogProps) {
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
      <DialogTitle>Delete permanently?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          This permanently removes{' '}
          <strong>
            {count} face{count !== 1 ? 's' : ''}
          </strong>{' '}
          and their biometric data. <strong>Your photos are NOT deleted.</strong> This cannot be
          undone.
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
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Set Profile Picture Dialog
// ---------------------------------------------------------------------------

interface SetProfilePictureDialogProps {
  open: boolean;
  onClose: () => void;
  personId: string;
  circleId: string;
  onSaved: () => void;
}

function SetProfilePictureDialog({
  open,
  onClose,
  personId,
  circleId,
  onSaved,
}: SetProfilePictureDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | null>(null);

  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [fullImageUrl, setFullImageUrl] = useState<string | null>(null);

  // react-easy-crop state
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPercents, setCroppedAreaPercents] = useState<Area | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load person's photos on open
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSelectedMediaId(null);
    setFullImageUrl(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPercents(null);
    setSaveError(null);
    setPhotosLoading(true);
    setPhotosError(null);
    listMedia({ personId, circleId, pageSize: 50 })
      .then((resp) => setMediaItems(resp.items))
      .catch((err) => setPhotosError(err instanceof Error ? err.message : 'Failed to load photos'))
      .finally(() => setPhotosLoading(false));
  }, [open, personId, circleId]);

  const handlePickPhoto = async (mediaId: string) => {
    setSelectedMediaId(mediaId);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPercents(null);
    setSaveError(null);
    try {
      const item = await getMedia(mediaId);
      setFullImageUrl(item.downloadUrl ?? item.thumbnailUrl ?? null);
    } catch {
      setFullImageUrl(null);
    }
    setStep(2);
  };

  const handleSave = async () => {
    if (!selectedMediaId || !croppedAreaPercents) return;
    setSaving(true);
    setSaveError(null);
    try {
      const normalized = {
        x: croppedAreaPercents.x / 100,
        y: croppedAreaPercents.y / 100,
        w: croppedAreaPercents.width / 100,
        h: croppedAreaPercents.height / 100,
      };
      await updatePerson(personId, {
        profileMediaItemId: selectedMediaId,
        profileCrop: normalized,
      });
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save profile picture');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updatePerson(personId, { profileMediaItemId: null, profileCrop: null });
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to clear profile picture');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{step === 1 ? 'Pick a photo' : 'Crop your photo'}</DialogTitle>
      <DialogContent>
        {step === 1 && (
          <>
            {photosLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            )}
            {photosError && <Alert severity="error">{photosError}</Alert>}
            {!photosLoading && !photosError && (
              <Grid container spacing={1}>
                {mediaItems.map((item) => (
                  <Grid key={item.id} size={{ xs: 4, sm: 3, md: 2 }}>
                    <Box
                      component="img"
                      src={item.thumbnailUrl ?? undefined}
                      alt=""
                      onClick={() => void handlePickPhoto(item.id)}
                      sx={{
                        width: '100%',
                        aspectRatio: '1/1',
                        objectFit: 'cover',
                        cursor: 'pointer',
                        borderRadius: 1,
                        display: 'block',
                      }}
                    />
                  </Grid>
                ))}
                {mediaItems.length === 0 && (
                  <Grid size={{ xs: 12 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
                      No photos found for this person.
                    </Typography>
                  </Grid>
                )}
              </Grid>
            )}
          </>
        )}

        {step === 2 && (
          <>
            {fullImageUrl ? (
              <Box sx={{ position: 'relative', height: 300, width: '100%' }}>
                <Cropper
                  image={fullImageUrl}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_croppedArea: Area, croppedAreaPixels: Area) => {
                    // react-easy-crop first arg is percentage-based (0–100)
                    setCroppedAreaPercents(_croppedArea);
                    void croppedAreaPixels; // pixels arg unused
                  }}
                />
              </Box>
            ) : (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            )}
            {saveError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {saveError}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {step === 2 && (
          <Button onClick={() => setStep(1)} disabled={saving}>
            Back
          </Button>
        )}
        {step === 2 && (
          <Button onClick={() => void handleClear()} disabled={saving}>
            Use detected face / Clear
          </Button>
        )}
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        {step === 2 && (
          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={saving || !croppedAreaPercents}
          >
            {saving ? <CircularProgress size={18} /> : 'Save'}
          </Button>
        )}
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
  onProfileUpdated,
  onToggleFavorite,
  isFavorite,
}: {
  personId: string;
  onClose: () => void;
  onRename: (personId: string, name: string) => Promise<void>;
  circleId: string;
  circleRole: string | null;
  allPeople: PersonListItem[];
  onPersonDeleted: () => void;
  onPersonMerged: () => void;
  onProfileUpdated?: () => void;
  onToggleFavorite: (personId: string, favorite: boolean) => Promise<void>;
  isFavorite: boolean;
}) {
  const navigate = useNavigate();
  const { person, loading, error } = usePerson(personId);
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [mediaMap, setMediaMap] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [profilePicDialogOpen, setProfilePicDialogOpen] = useState(false);

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
    favorite: false,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };

  // Cast person to the PersonAvatarPerson shape (includes new optional fields)
  const avatarPerson = {
    id: person.id,
    name: person.name,
    coverFace: person.coverFace,
    profileMediaItemId: (person as PersonDetail & { profileMediaItemId?: string | null }).profileMediaItemId,
    profileCrop: (person as PersonDetail & { profileCrop?: { x: number; y: number; w: number; h: number } | null }).profileCrop,
  };

  return (
    <Box sx={{ width: { xs: '100vw', sm: 400 }, maxWidth: '100vw', p: 2 }}>
      {/* Person avatar — centered at top */}
      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
        <PersonAvatar person={avatarPerson} size={72} />
      </Box>

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
            <IconButton onClick={() => setEditing(true)} aria-label="Edit name">
              <EditIcon fontSize="small" />
            </IconButton>
          </>
        )}

        {/* Merge action — admin/collaborator only */}
        {canManage && (
          <IconButton
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
            color="error"
            onClick={() => setDeleteDialogOpen(true)}
            aria-label="Delete person"
            title="Delete person"
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        )}

        {/* Favorite toggle */}
        <Tooltip title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
          <IconButton
            disabled={toggling}
            onClick={() => {
              setToggling(true);
              onToggleFavorite(person.id, !isFavorite).finally(() => setToggling(false));
            }}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            sx={{ color: isFavorite ? 'warning.main' : 'text.secondary' }}
          >
            {isFavorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        <IconButton onClick={onClose} aria-label="Close">
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

      {/* Set profile picture button */}
      <Button
        variant="outlined"
        fullWidth
        startIcon={<PhotoCameraIcon />}
        onClick={() => setProfilePicDialogOpen(true)}
        sx={{ mb: 2 }}
        disabled={!canManage}
      >
        Set profile picture
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
              {face.faceThumbnailUrl ? (
                <Box
                  component="img"
                  src={face.faceThumbnailUrl}
                  sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 1, display: 'block' }}
                />
              ) : imgUrl ? (
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

      {/* Set profile picture dialog */}
      <SetProfilePictureDialog
        open={profilePicDialogOpen}
        onClose={() => setProfilePicDialogOpen(false)}
        personId={person.id}
        circleId={circleId}
        onSaved={() => {
          setProfilePicDialogOpen(false);
          onProfileUpdated?.();
        }}
      />
    </Box>
  );
}


// ---------------------------------------------------------------------------
// Unassigned Faces Section (lone detected faces not yet in any Person)
// ---------------------------------------------------------------------------

/**
 * Renders a selectable grid of face thumbnails, resolving each face's media
 * thumbnail URL on demand. Used by both the live unassigned pool and the
 * archived faces sub-view.
 */
function FaceThumbGrid({
  faces,
  selectedIds,
  onToggle,
}: {
  faces: UnassignedFaceDto[];
  selectedIds: Set<string>;
  onToggle: (faceId: string) => void;
}) {
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  // Resolve thumbnail URLs for each unique mediaItemId
  useEffect(() => {
    if (faces.length === 0) return;
    const uniqueIds = [...new Set(faces.map((f) => f.mediaItemId))];
    const missing = uniqueIds.filter((id) => !mediaUrls[id]);
    if (missing.length === 0) return;
    missing.forEach((mediaId) => {
      getMedia(mediaId)
        .then((item) => {
          const url = item.downloadUrl ?? item.thumbnailUrl;
          if (url) {
            setMediaUrls((prev) => ({ ...prev, [mediaId]: url }));
          }
        })
        .catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faces]);

  return (
    <Grid container spacing={1}>
      {faces.map((face) => {
        const imgUrl = mediaUrls[face.mediaItemId];
        const selected = selectedIds.has(face.faceId);
        return (
          <Grid key={face.faceId}>
            <Box
              onClick={() => onToggle(face.faceId)}
              sx={{
                position: 'relative',
                cursor: 'pointer',
                borderRadius: 1,
                border: selected ? '2px solid' : '2px solid transparent',
                borderColor: selected ? 'primary.main' : 'transparent',
                '&:hover': { borderColor: 'primary.light' },
              }}
            >
              {face.faceThumbnailUrl ? (
                <Box
                  component="img"
                  src={face.faceThumbnailUrl}
                  sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 1, display: 'block' }}
                />
              ) : imgUrl ? (
                <FaceCrop imageUrl={imgUrl} boundingBox={face.boundingBox} size={72} />
              ) : (
                <Box sx={{ width: 72, height: 72, bgcolor: 'grey.200', borderRadius: 1 }} />
              )}
              <Checkbox
                size="small"
                checked={selected}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  p: 0.25,
                  color: 'white',
                  '&.Mui-checked': { color: 'primary.main' },
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggle(face.faceId)}
              />
            </Box>
          </Grid>
        );
      })}
    </Grid>
  );
}

function UnassignedFacesSection({
  circleId,
  allPeople,
  onAssigned,
}: {
  circleId: string;
  allPeople: PersonListItem[];
  onAssigned: () => void;
}) {
  const { faces, loading, error, refresh, hide } = useUnassignedFaces(circleId);
  const {
    faces: archivedFaces,
    loading: archivedLoading,
    error: archivedError,
    refresh: refreshArchived,
    unhide,
    purge,
  } = useUnassignedFaces(circleId, { archived: true });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');
  const [creating, setCreating] = useState(false);
  const [assignTarget, setAssignTarget] = useState<PersonListItem | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Archived sub-view state
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);

  // Refresh on mount and whenever the window regains focus (handles stale IDs
  // after detection re-runs in another tab)
  useEffect(() => {
    void refresh();
    void refreshArchived();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId]);

  const toggleSelect = (faceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  };

  const toggleArchivedSelect = (faceId: string) => {
    setArchivedSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  };

  const handleArchive = async () => {
    if (selectedIds.size === 0) return;
    setArchiving(true);
    setActionError(null);
    try {
      const ids = [...selectedIds];
      const result = await hide(ids);
      setSelectedIds(new Set());
      await Promise.all([refresh(), refreshArchived()]);
      setSuccessMsg(
        `Archived ${result.hidden} face${result.hidden !== 1 ? 's' : ''}.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isStale =
        msg.toLowerCase().includes('not found') ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 400;
      if (isStale) {
        await refresh();
        setSelectedIds(new Set());
        setActionError(
          'The face list changed (detection re-ran). Please reselect and try again.',
        );
      } else {
        setActionError(msg || 'Failed to archive faces');
      }
    } finally {
      setArchiving(false);
    }
  };

  const handleRestore = async () => {
    if (archivedSelectedIds.size === 0) return;
    setRestoring(true);
    setActionError(null);
    try {
      const ids = [...archivedSelectedIds];
      const result = await unhide(ids);
      setArchivedSelectedIds(new Set());
      await Promise.all([refresh(), refreshArchived()]);
      setSuccessMsg(
        `Restored ${result.unhidden} face${result.unhidden !== 1 ? 's' : ''}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to restore faces');
    } finally {
      setRestoring(false);
    }
  };

  const handlePurge = async () => {
    if (archivedSelectedIds.size === 0) return;
    const ids = [...archivedSelectedIds];
    const result = await purge(ids);
    setArchivedSelectedIds(new Set());
    await refreshArchived();
    setSuccessMsg(
      `Permanently deleted ${result.deleted} face${result.deleted !== 1 ? 's' : ''}.`,
    );
  };

  const handleCreatePerson = async () => {
    if (!newPersonName.trim() || selectedIds.size === 0) return;
    setCreating(true);
    setActionError(null);
    try {
      await createPersonService({
        circleId,
        name: newPersonName.trim(),
        faceIds: [...selectedIds],
      });
      setSelectedIds(new Set());
      setNewPersonName('');
      setNameDialogOpen(false);
      await refresh();
      onAssigned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isStale =
        msg.toLowerCase().includes('not found') ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 400;
      if (isStale) {
        await refresh();
        setSelectedIds(new Set());
        setNewPersonName('');
        setNameDialogOpen(false);
        setActionError(
          'The face list changed (detection re-ran). Please reselect and try again.',
        );
      } else {
        setActionError(msg || 'Failed to create person');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleAssignToExisting = async () => {
    if (!assignTarget || selectedIds.size === 0) return;
    setAssigning(true);
    setActionError(null);
    try {
      await assignFacesService(assignTarget.id, [...selectedIds]);
      setSelectedIds(new Set());
      setAssignTarget(null);
      await refresh();
      onAssigned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isStale =
        msg.toLowerCase().includes('not found') ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 400;
      if (isStale) {
        await refresh();
        setSelectedIds(new Set());
        setAssignTarget(null);
        setActionError(
          'The face list changed (detection re-ran). Please reselect and try again.',
        );
      } else {
        setActionError(msg || 'Failed to assign faces');
      }
    } finally {
      setAssigning(false);
    }
  };

  if (loading) return <CircularProgress size={24} />;
  if (error) return <Alert severity="error">{error}</Alert>;
  // hide section entirely if there are neither live nor archived unassigned faces
  if (faces.length === 0 && archivedFaces.length === 0) return null;

  const getPersonLabel = (p: PersonListItem) =>
    p.name ?? `Unlabeled (${p.id.slice(0, 6)})`;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Unassigned Faces ({faces.length})
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Individual detected faces not yet linked to a person. Select one or more to name, assign, or archive.
      </Typography>

      {/* Action bar — visible when faces are selected */}
      {selectedIds.size > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
          >
            <Typography variant="body2">
              {selectedIds.size} face{selectedIds.size !== 1 ? 's' : ''} selected
            </Typography>

            <Button
              size="small"
              variant="contained"
              onClick={() => setNameDialogOpen(true)}
              disabled={creating || assigning || archiving}
              sx={{ minHeight: 44 }}
            >
              Name as new person
            </Button>

            <Autocomplete
              size="small"
              options={allPeople}
              getOptionLabel={getPersonLabel}
              value={assignTarget}
              onChange={(_, val) => setAssignTarget(val)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Assign to existing person"
                  fullWidth
                  sx={{ minWidth: 200 }}
                />
              )}
              sx={{ minWidth: 200, width: { xs: '100%', sm: 'auto' } }}
            />
            <Button
              size="small"
              variant="outlined"
              onClick={() => void handleAssignToExisting()}
              disabled={!assignTarget || assigning || creating || archiving}
              startIcon={assigning ? <CircularProgress size={14} /> : undefined}
              sx={{ minHeight: 44 }}
            >
              {assigning ? 'Assigning…' : 'Assign'}
            </Button>

            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => void handleArchive()}
              disabled={creating || assigning || archiving}
              startIcon={archiving ? <CircularProgress size={14} /> : <VisibilityOffIcon fontSize="small" />}
              sx={{ minHeight: 44 }}
            >
              {archiving ? 'Archiving…' : 'Archive'}
            </Button>

            <Button size="small" onClick={() => setSelectedIds(new Set())} sx={{ minHeight: 44 }}>
              Clear
            </Button>
          </Stack>
          {actionError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {actionError}
            </Alert>
          )}
        </Paper>
      )}

      {/* Live face grid */}
      <FaceThumbGrid faces={faces} selectedIds={selectedIds} onToggle={toggleSelect} />

      {/* Archived faces sub-view */}
      {archivedFaces.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Button
            size="small"
            variant="text"
            color="inherit"
            startIcon={<VisibilityIcon fontSize="small" />}
            endIcon={
              <Badge
                color="default"
                badgeContent={archivedFaces.length}
                sx={{ '& .MuiBadge-badge': { position: 'static', transform: 'none' } }}
              />
            }
            onClick={() => setShowArchived((v) => !v)}
            sx={{ minHeight: 44 }}
          >
            {showArchived ? 'Hide archived faces' : 'Show archived faces'}
          </Button>

          <Collapse in={showArchived} unmountOnExit>
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Archived faces are hidden from the pool above. Restore them, or delete them
                permanently (removes the face and its biometric data — your photos are kept).
              </Typography>

              {archivedError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {archivedError}
                </Alert>
              )}

              {/* Archived action bar — visible when archived faces are selected */}
              {archivedSelectedIds.size > 0 && (
                <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2}
                    sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
                  >
                    <Typography variant="body2">
                      {archivedSelectedIds.size} face
                      {archivedSelectedIds.size !== 1 ? 's' : ''} selected
                    </Typography>

                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => void handleRestore()}
                      disabled={restoring}
                      startIcon={restoring ? <CircularProgress size={14} /> : <RestoreIcon fontSize="small" />}
                      sx={{ minHeight: 44 }}
                    >
                      {restoring ? 'Restoring…' : 'Restore'}
                    </Button>

                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      onClick={() => setPurgeDialogOpen(true)}
                      disabled={restoring}
                      startIcon={<DeleteForeverIcon fontSize="small" />}
                      sx={{ minHeight: 44 }}
                    >
                      Delete permanently
                    </Button>

                    <Button
                      size="small"
                      onClick={() => setArchivedSelectedIds(new Set())}
                      sx={{ minHeight: 44 }}
                    >
                      Clear
                    </Button>
                  </Stack>
                </Paper>
              )}

              {archivedLoading ? (
                <CircularProgress size={24} />
              ) : (
                <FaceThumbGrid
                  faces={archivedFaces}
                  selectedIds={archivedSelectedIds}
                  onToggle={toggleArchivedSelect}
                />
              )}
            </Box>
          </Collapse>
        </Box>
      )}

      {/* Success feedback */}
      <Snackbar
        open={successMsg !== null}
        autoHideDuration={4000}
        onClose={() => setSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setSuccessMsg(null)} sx={{ width: '100%' }}>
          {successMsg}
        </Alert>
      </Snackbar>

      {/* Purge (permanent delete) confirm dialog — only reachable from archived sub-view */}
      <PurgeFacesDialog
        open={purgeDialogOpen}
        count={archivedSelectedIds.size}
        onClose={() => setPurgeDialogOpen(false)}
        onConfirm={handlePurge}
      />

      {/* Name as new person dialog */}
      <Dialog
        open={nameDialogOpen}
        onClose={() => setNameDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Name as New Person</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Creating a person from {selectedIds.size} selected face
            {selectedIds.size !== 1 ? 's' : ''}.
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="Person name"
            value={newPersonName}
            onChange={(e) => setNewPersonName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreatePerson();
            }}
            autoFocus
          />
          {actionError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {actionError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNameDialogOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreatePerson()}
            disabled={!newPersonName.trim() || creating}
            startIcon={creating ? <CircularProgress size={14} /> : undefined}
          >
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// People bulk toolbar (for selection mode on the main People tab)
// ---------------------------------------------------------------------------

interface PeopleBulkToolbarProps {
  selected: Set<string>;
  allIds: string[];
  circleId: string;
  onClear: () => void;
  onSelectAll: () => void;
  /** If true, show Unhide + Purge actions instead of Hide */
  hiddenMode?: boolean;
  onHideSelected: () => Promise<void>;
  onUnhideSelected: () => Promise<void>;
  onPurgeSelected: () => void; // opens confirm dialog
}

function PeopleBulkToolbar({
  selected,
  allIds,
  onClear,
  onSelectAll,
  hiddenMode,
  onHideSelected,
  onUnhideSelected,
  onPurgeSelected,
}: PeopleBulkToolbarProps) {
  const [loading, setLoading] = useState(false);
  const count = selected.size;

  if (count === 0) return null;

  const handleHide = async () => {
    setLoading(true);
    try {
      await onHideSelected();
    } finally {
      setLoading(false);
    }
  };

  const handleUnhide = async () => {
    setLoading(true);
    try {
      await onUnhideSelected();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        position: 'sticky',
        top: 64,
        zIndex: (theme) => theme.zIndex.appBar + 2,
        mx: 0,
        mb: 1.5,
        px: { xs: 1, sm: 2 },
        py: 1,
        minHeight: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        bgcolor: 'background.paper',
        color: 'text.primary',
        borderRadius: 2,
        boxShadow: 3,
      }}
    >
      <Tooltip title="Cancel selection">
        <IconButton aria-label="Cancel selection" onClick={onClear}>
          <CloseIcon />
        </IconButton>
      </Tooltip>

      <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'primary.main' }}>
        {count} selected
      </Typography>

      <Box sx={{ flexGrow: 1 }} />

      <Tooltip title={`Select all (${allIds.length})`}>
        <IconButton aria-label="Select all" onClick={onSelectAll}>
          <SelectAllIcon />
        </IconButton>
      </Tooltip>

      {!hiddenMode && (
        <Tooltip title="Hide selected (removes from People page; photos stay)">
          <IconButton
            aria-label="Hide selected"
            onClick={() => void handleHide()}
            disabled={loading}
          >
            {loading ? <CircularProgress size={20} /> : <VisibilityOffIcon />}
          </IconButton>
        </Tooltip>
      )}

      {hiddenMode && (
        <>
          <Tooltip title="Unhide selected">
            <IconButton
              aria-label="Unhide selected"
              onClick={() => void handleUnhide()}
              disabled={loading}
            >
              {loading ? <CircularProgress size={20} /> : <VisibilityIcon />}
            </IconButton>
          </Tooltip>

          <Tooltip title="Delete permanently (removes person and face data; photos stay)">
            <IconButton
              aria-label="Delete permanently"
              color="error"
              onClick={onPurgeSelected}
              disabled={loading}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Hidden People View
// ---------------------------------------------------------------------------

function HiddenPeopleView({
  circleId,
  onSuccess,
  onError,
}: {
  circleId: string;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const {
    data: hiddenData,
    loading: hiddenLoading,
    error: hiddenError,
    refresh: refreshHidden,
    unhide,
    purge,
  } = usePeople(circleId, { hidden: true, includeUnlabeled: true });

  const hiddenPeople = hiddenData?.items ?? [];

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);

  const handleToggleSelect = (person: PersonListItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(person.id)) next.delete(person.id);
      else next.add(person.id);
      return next;
    });
    if (!selectionMode) setSelectionMode(true);
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(hiddenPeople.map((p) => p.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const handleUnhideSingle = async (person: PersonListItem) => {
    try {
      const result = await unhide([person.id]);
      onSuccess(`Unhid ${result.unhidden} person`);
      await refreshHidden();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to unhide');
    }
  };

  const handleUnhideSelected = async () => {
    const ids = Array.from(selectedIds);
    try {
      const result = await unhide(ids);
      onSuccess(`Unhid ${result.unhidden} person${result.unhidden !== 1 ? 's' : ''}`);
      handleClearSelection();
      await refreshHidden();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to unhide');
    }
  };

  const handlePurgeSelected = async () => {
    const ids = Array.from(selectedIds);
    try {
      const result = await purge(ids);
      onSuccess(
        `Permanently deleted ${result.deleted} person record${result.deleted !== 1 ? 's' : ''}`,
      );
      handleClearSelection();
      setPurgeDialogOpen(false);
      await refreshHidden();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete');
      throw err;
    }
  };

  if (hiddenError) {
    return <Alert severity="error">{hiddenError}</Alert>;
  }

  return (
    <Box>
      {/* Bulk toolbar */}
      {selectionMode && selectedIds.size > 0 && (
        <PeopleBulkToolbar
          selected={selectedIds}
          allIds={hiddenPeople.map((p) => p.id)}
          circleId={circleId}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          hiddenMode
          onHideSelected={async () => { /* no-op in hidden view */ }}
          onUnhideSelected={handleUnhideSelected}
          onPurgeSelected={() => setPurgeDialogOpen(true)}
        />
      )}

      {hiddenLoading && !hiddenData ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : hiddenPeople.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <VisibilityOffIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" color="text.secondary">
            No hidden people. Use the hide button on any person card to remove them from this page.
          </Typography>
        </Box>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Hidden people are excluded from the People page but their photos remain fully searchable.
            Click the eye icon to unhide, or select multiple to unhide/delete in bulk.
          </Typography>
          <PersonGrid
            people={hiddenPeople}
            onPersonClick={(person) => {
              // In selection mode, clicking toggles selection
              if (selectionMode) {
                handleToggleSelect(person);
              } else {
                setSelectionMode(true);
                handleToggleSelect(person);
              }
            }}
            loading={hiddenLoading}
            onUnhide={handleUnhideSingle}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            emptyMessage="No hidden people"
          />
        </>
      )}

      {/* Purge confirm dialog */}
      <PurgePeopleDialog
        open={purgeDialogOpen}
        count={selectedIds.size}
        onClose={() => setPurgeDialogOpen(false)}
        onConfirm={handlePurgeSelected}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PeoplePage() {
  const { activeCircleId, activeCircleRole } = useCircleContext();
  const navigate = useNavigate();
  const [selectedPerson, setSelectedPerson] = useState<PersonListItem | null>(null);

  // Tab: 0 = People, 1 = Hidden
  const [activeTab, setActiveTab] = useState(0);

  // Optimistic favorite overrides: maps personId -> boolean
  const [pendingFavorites, setPendingFavorites] = useState<Record<string, boolean>>({});

  // Selection mode on the main People tab
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Snackbar
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const showSuccess = (message: string) =>
    setSnackbar({ open: true, message, severity: 'success' });
  const showError = (message: string) =>
    setSnackbar({ open: true, message, severity: 'error' });

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
    hide: hidePeople,
  } = usePeople(activeCircleId, { includeUnlabeled: false });

  // Unlabeled people
  const {
    data: unlabeledData,
    loading: unlabeledLoading,
    error: unlabeledError,
    refresh: refreshUnlabeled,
    hide: hideUnlabeled,
  } = usePeople(activeCircleId, { includeUnlabeled: true });

  // Hidden people count (for badge)
  const {
    data: hiddenData,
    refresh: refreshHidden,
  } = usePeople(activeCircleId, { hidden: true, includeUnlabeled: true });
  const hiddenCount = hiddenData?.meta.totalItems ?? 0;

  // Filter unlabeled from the unlabeled fetch
  const unlabeledPeople = (unlabeledData?.items ?? []).filter((p) => p.isUnlabeled);
  // Apply optimistic favorite overrides so UI reflects the toggle immediately
  const labeledPeople = (labeledData?.items ?? []).map((p) =>
    Object.prototype.hasOwnProperty.call(pendingFavorites, p.id)
      ? { ...p, favorite: pendingFavorites[p.id] }
      : p,
  );
  const allPeople = [...labeledPeople, ...unlabeledPeople];
  // All IDs for select-all
  const allVisibleIds = allPeople.map((p) => p.id);

  const handleBiometricsDeleted = async (deletedFaces: number, deletedPeople: number) => {
    setBiometricsResult({ deletedFaces, deletedPeople });
    await Promise.all([refreshLabeled(), refreshUnlabeled(), refreshHidden()]);
  };

  const handlePersonClick = (person: PersonListItem) => {
    if (selectionMode) {
      handleToggleSelect(person);
    } else {
      setSelectedPerson(person);
    }
  };

  const handleToggleSelect = (person: PersonListItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(person.id)) next.delete(person.id);
      else next.add(person.id);
      return next;
    });
    if (!selectionMode) setSelectionMode(true);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(allVisibleIds));
  };

  // Hide a single person from the named/unlabeled grid
  const handleHideSingle = async (person: PersonListItem) => {
    const hideFunc = person.isUnlabeled ? hideUnlabeled : hidePeople;
    try {
      const result = await hideFunc([person.id]);
      showSuccess(`Hidden ${result.hidden} person${result.hidden !== 1 ? 's' : ''}`);
      await Promise.all([refreshLabeled(), refreshUnlabeled(), refreshHidden()]);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to hide');
    }
  };

  // Bulk hide selected
  const handleHideSelected = async () => {
    const ids = Array.from(selectedIds);
    // We call via the labeled hook which accepts any ids (both named and unlabeled)
    // The hook calls bulkHidePeople which handles the mix server-side.
    try {
      const result = await hidePeople(ids);
      showSuccess(`Hidden ${result.hidden} person${result.hidden !== 1 ? 's' : ''}`);
      handleClearSelection();
      await Promise.all([refreshLabeled(), refreshUnlabeled(), refreshHidden()]);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to hide');
    }
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
    await Promise.all([refreshLabeled(), refreshUnlabeled(), refreshHidden()]);
  };

  const handlePersonMerged = async () => {
    await Promise.all([refreshLabeled(), refreshUnlabeled()]);
  };

  const handleToggleFavorite = async (personId: string, favorite: boolean) => {
    // Optimistic update
    setPendingFavorites((prev) => ({ ...prev, [personId]: favorite }));
    try {
      await setPersonFavorite(personId, favorite);
      // Refetch so favorites-first ordering from backend is applied
      await refreshLabeled();
    } catch {
      // Revert optimistic update on error
      setPendingFavorites((prev) => {
        const next = { ...prev };
        delete next[personId];
        return next;
      });
      await refreshLabeled();
    } finally {
      // Remove the pending override after the refetch has applied
      setPendingFavorites((prev) => {
        const next = { ...prev };
        delete next[personId];
        return next;
      });
    }
  };

  if (!activeCircleId) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Alert severity="info">Select a circle to view people.</Alert>
      </Container>
    );
  }

  // People UI
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {/* Header */}
      <Stack direction="row" sx={{ mb: 3, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h4">People</Typography>

        {/* Settings menu — circle_admin only */}
        {activeCircleRole === 'circle_admin' && (
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

      {/* Tabs: People / Hidden */}
      <Tabs
        value={activeTab}
        onChange={(_, v: number) => {
          setActiveTab(v);
          handleClearSelection();
        }}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label="People" value={0} />
        <Tab
          label={
            hiddenCount > 0 ? (
              <Badge badgeContent={hiddenCount} color="default" max={999}>
                Hidden
              </Badge>
            ) : (
              'Hidden'
            )
          }
          value={1}
          icon={<VisibilityOffIcon fontSize="small" />}
          iconPosition="start"
        />
      </Tabs>

      {/* ── MAIN PEOPLE TAB ── */}
      {activeTab === 0 && (
        <>
          {/* Bulk toolbar — shown when items are selected */}
          {selectionMode && selectedIds.size > 0 && (
            <PeopleBulkToolbar
              selected={selectedIds}
              allIds={allVisibleIds}
              circleId={activeCircleId}
              onClear={handleClearSelection}
              onSelectAll={handleSelectAll}
              hiddenMode={false}
              onHideSelected={handleHideSelected}
              onUnhideSelected={async () => { /* no-op */ }}
              onPurgeSelected={() => { /* no-op: main tab does not offer purge */ }}
            />
          )}

          {/* "Photos with no faces" shortcut */}
          <Box sx={{ mb: 3 }}>
            <Button
              variant="outlined"
              startIcon={<ImageSearchIcon />}
              onClick={() => navigate('/media?noFaces=1')}
              sx={{ minHeight: 44 }}
            >
              Photos with no faces detected
            </Button>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Find photos where face detection found no faces — add people manually.
            </Typography>
          </Box>

          {/* Selection mode hint */}
          {!selectionMode && allPeople.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Tip: click any card while holding the hide button, or click multiple cards after
              selecting one, to hide clusters in bulk.
            </Typography>
          )}

          {/* Labeled people section */}
          <Box sx={{ mb: 4 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Named People ({labeledPeople.length})
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Tip: open a person and use the Merge button to combine duplicates.
            </Typography>
            <PersonGrid
              people={labeledPeople}
              onPersonClick={handlePersonClick}
              loading={labeledLoading}
              emptyMessage="No named people yet. Use 'Find People' then name the clusters below."
              onToggleFavorite={(person) =>
                void handleToggleFavorite(
                  person.id,
                  !(pendingFavorites[person.id] ?? person.favorite),
                )
              }
              onHide={handleHideSingle}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
            />
          </Box>

          <Divider sx={{ mb: 3 }} />

          {/* Unassigned faces section — lone detected faces */}
          {activeCircleId && (
            <Box sx={{ mb: 4 }}>
              <UnassignedFacesSection
                circleId={activeCircleId}
                allPeople={allPeople}
                onAssigned={() => void Promise.all([refreshLabeled(), refreshUnlabeled()])}
              />
            </Box>
          )}

          <Divider sx={{ mb: 3 }} />

          {/* Unknown faces section */}
          <UnknownFacesReview
            unlabeledPeople={unlabeledPeople}
            onPersonClick={handlePersonClick}
            onCluster={handleCluster}
            onRename={handleRename}
            canCluster={canCluster}
            loading={unlabeledLoading}
            onHide={handleHideSingle}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
          />
        </>
      )}

      {/* ── HIDDEN PEOPLE TAB ── */}
      {activeTab === 1 && activeCircleId && (
        <HiddenPeopleView
          circleId={activeCircleId}
          onSuccess={(msg) => {
            showSuccess(msg);
            void refreshHidden();
          }}
          onError={showError}
        />
      )}

      {/* Person detail drawer */}
      <Drawer
        anchor="right"
        open={selectedPerson !== null}
        onClose={() => setSelectedPerson(null)}
        ModalProps={{ keepMounted: false }}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: 400 },
            maxWidth: '100%',
          },
        }}
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
            onProfileUpdated={() => void Promise.all([refreshLabeled(), refreshUnlabeled()])}
            onToggleFavorite={handleToggleFavorite}
            isFavorite={
              pendingFavorites[selectedPerson.id] ?? selectedPerson.favorite ?? false
            }
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

      {/* Snackbar feedback */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}
