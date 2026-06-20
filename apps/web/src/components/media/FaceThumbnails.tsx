import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Chip,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  Skeleton,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Autocomplete,
  Divider,
} from '@mui/material';
import { Face as FaceIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { useMediaFaces } from '../../hooks/useMediaFaces';
import type { MediaFaceStatusType, DetectedFaceDto } from '../../services/face';
import {
  listPeople,
  createPerson,
  assignFaces,
  unassignFace,
  addPersonToMedia,
  removePersonFromMedia,
} from '../../services/face';
import type { PersonListItem } from '../../services/face';
import { FaceCrop } from '../people/FaceCrop';

function statusChipProps(status: MediaFaceStatusType): {
  label: string;
  color: 'success' | 'warning' | 'info' | 'default' | 'error';
} {
  switch (status) {
    case 'processed':
      return { label: 'Processed', color: 'success' };
    case 'pending':
      return { label: 'Pending', color: 'warning' };
    case 'processing':
      return { label: 'Processing', color: 'info' };
    case 'no_faces':
      return { label: 'No Faces', color: 'default' };
    case 'failed':
      return { label: 'Failed', color: 'error' };
    default:
      return { label: 'Not Processed', color: 'default' };
  }
}

interface FaceThumbnailsProps {
  mediaId: string;
  mediaType?: string;
  thumbnailUrl?: string;
  /** Full-resolution download URL. When provided it is preferred over thumbnailUrl
   *  for face crops and the overlay image so crops are sharp. */
  downloadUrl?: string;
  circleId?: string;
}

// ---------------------------------------------------------------------------
// AssignFaceDialog — inline in same file
// ---------------------------------------------------------------------------

interface AssignFaceDialogProps {
  open: boolean;
  face: DetectedFaceDto | null;
  /** Full-resolution URL preferred; falls back to thumbnailUrl for sharp crop preview. */
  imageUrl: string | undefined;
  circleId: string;
  onClose: () => void;
  onSuccess: () => void;
}

function AssignFaceDialog({
  open,
  face,
  imageUrl,
  circleId,
  onClose,
  onSuccess,
}: AssignFaceDialogProps) {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<PersonListItem | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !circleId) return;
    setPeopleLoading(true);
    setError(null);
    listPeople(circleId, { pageSize: 100 })
      .then((res) => setPeople(res.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load people'))
      .finally(() => setPeopleLoading(false));
  }, [open, circleId]);

  useEffect(() => {
    if (!open) {
      setNewName('');
      setSelectedPerson(null);
      setError(null);
    }
  }, [open]);

  if (!face) return null;
  const isAssigned = face.personId !== null;

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPerson({ circleId, name: newName.trim(), faceIds: [face.id] });
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create person');
    } finally {
      setCreating(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedPerson) return;
    setAssigning(true);
    setError(null);
    try {
      await assignFaces(selectedPerson.id, [face.id]);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign face');
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async () => {
    if (!face.personId) return;
    setUnassigning(true);
    setError(null);
    try {
      await unassignFace(face.personId, face.id);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unassign face');
    } finally {
      setUnassigning(false);
    }
  };

  const getPersonLabel = (p: PersonListItem) =>
    p.name ?? `Unlabeled (${p.id.slice(0, 6)})`;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {isAssigned ? 'Reassign or Unassign Face' : 'Assign Face to Person'}
      </DialogTitle>
      <DialogContent>
        {/* Face crop preview — use full-res imageUrl for a sharp crop */}
        {imageUrl && face && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <FaceCrop imageUrl={imageUrl} boundingBox={face.boundingBox} size={96} />
          </Box>
        )}

        {isAssigned && (
          <Typography variant="body2" sx={{ mb: 2 }}>
            Currently assigned to: <strong>{face.personName ?? 'Unknown'}</strong>
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Unassign option — only when assigned */}
        {isAssigned && (
          <>
            <Button
              fullWidth
              variant="outlined"
              color="error"
              onClick={() => void handleUnassign()}
              disabled={unassigning || assigning}
              startIcon={unassigning ? <CircularProgress size={14} /> : undefined}
              sx={{ mb: 2 }}
            >
              {unassigning ? 'Unassigning…' : 'Unassign (return to unknown pool)'}
            </Button>
            <Divider sx={{ mb: 2 }}>
              <Typography variant="caption">or reassign to</Typography>
            </Divider>
          </>
        )}

        {/* Assign to existing person */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {isAssigned ? 'Reassign to existing person' : 'Assign to existing person'}
        </Typography>
        <Autocomplete
          options={people}
          getOptionLabel={getPersonLabel}
          value={selectedPerson}
          onChange={(_, val) => setSelectedPerson(val)}
          loading={peopleLoading}
          renderInput={(params) => (
            <TextField {...params} size="small" label="Select person" sx={{ mb: 1 }} />
          )}
          sx={{ mb: 1 }}
        />
        <Button
          fullWidth
          variant="contained"
          onClick={() => void handleAssign()}
          disabled={!selectedPerson || assigning || unassigning}
          startIcon={assigning ? <CircularProgress size={14} /> : undefined}
          sx={{ mb: 2 }}
        >
          {assigning ? 'Assigning…' : isAssigned ? 'Reassign' : 'Assign'}
        </Button>

        {/* Create new person — only when unassigned */}
        {!isAssigned && (
          <>
            <Divider sx={{ mb: 2 }}>
              <Typography variant="caption">or create new</Typography>
            </Divider>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Create new person
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Person name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              sx={{ mb: 1 }}
            />
            <Button
              fullWidth
              variant="outlined"
              onClick={() => void handleCreate()}
              disabled={!newName.trim() || creating || assigning}
              startIcon={creating ? <CircularProgress size={14} /> : undefined}
            >
              {creating ? 'Creating…' : 'Create person'}
            </Button>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main FaceThumbnails component
// ---------------------------------------------------------------------------

export function FaceThumbnails({
  mediaId,
  mediaType,
  thumbnailUrl,
  downloadUrl,
  circleId,
}: FaceThumbnailsProps) {
  const theme = useTheme();
  const { faces, status, loading, error, rerun, rerunLoading, refresh } =
    useMediaFaces(mediaId);
  const [assignDialogFace, setAssignDialogFace] = useState<DetectedFaceDto | null>(null);

  // Manual people state
  const [peopleSuggestions, setPeopleSuggestions] = useState<PersonListItem[]>([]);
  const [addingPerson, setAddingPerson] = useState(false);
  const [removingPersonId, setRemovingPersonId] = useState<string | null>(null);
  const [manualPeopleError, setManualPeopleError] = useState<string | null>(null);
  const [personInputValue, setPersonInputValue] = useState('');

  const canAssign = Boolean(circleId);

  // Load people suggestions when circleId changes (only when canAssign)
  useEffect(() => {
    if (!circleId || !canAssign) return;
    listPeople(circleId, { pageSize: 100 })
      .then((res) => setPeopleSuggestions(res.items))
      .catch(() => setPeopleSuggestions([]));
  }, [circleId, canAssign]);

  const handleAddPerson = async (personId?: string, name?: string) => {
    if (!personId && !name?.trim()) return;
    setAddingPerson(true);
    setManualPeopleError(null);
    try {
      await addPersonToMedia(mediaId, personId ? { personId } : { name: name!.trim() });
      setPersonInputValue('');
      void refresh();
    } catch (err) {
      setManualPeopleError(err instanceof Error ? err.message : 'Failed to add person');
    } finally {
      setAddingPerson(false);
    }
  };

  const handleRemovePerson = async (personId: string) => {
    setRemovingPersonId(personId);
    setManualPeopleError(null);
    try {
      await removePersonFromMedia(mediaId, personId);
      void refresh();
    } catch (err) {
      setManualPeopleError(err instanceof Error ? err.message : 'Failed to remove person');
    } finally {
      setRemovingPersonId(null);
    }
  };

  if (mediaType === 'video') return null;

  if (loading) {
    return <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 1 }} />;
  }

  const chipProps = status
    ? statusChipProps(status.status)
    : { label: 'Not Processed', color: 'default' as const };

  // Separate detected faces (with bounding boxes) from manual associations
  const detectedFaces = faces.filter((f) => f.providerKey !== 'manual');
  const manualFaces = faces.filter((f) => f.providerKey === 'manual');

  return (
    <Box>
      {/* Status row */}
      <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label={chipProps.label} color={chipProps.color} size="small" icon={<FaceIcon />} />
        {status?.providerKey && (
          <Typography variant="caption" color="text.secondary">
            {status.providerKey}
            {status.modelVersion ? ` · ${status.modelVersion}` : ''}
          </Typography>
        )}
        {status?.processedAt && (
          <Typography variant="caption" color="text.secondary">
            {new Date(status.processedAt).toLocaleDateString()}
          </Typography>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {/* Image with face box overlays — prefer downloadUrl (full-res) when available */}
      {thumbnailUrl && (
        <Box sx={{ position: 'relative', display: 'inline-block', width: '100%', mb: 1 }}>
          <Box
            component="img"
            src={downloadUrl ?? thumbnailUrl}
            alt="Media thumbnail"
            sx={{ width: '100%', display: 'block', borderRadius: 1 }}
          />
          {detectedFaces.map((face) => (
            <FaceBox
              key={face.id}
              face={face}
              theme={theme}
              clickable={canAssign}
              onClick={canAssign ? () => setAssignDialogFace(face) : undefined}
            />
          ))}
        </Box>
      )}

      {/* Face count */}
      {detectedFaces.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {detectedFaces.length} face{detectedFaces.length !== 1 ? 's' : ''} detected
          {canAssign && ' · click a face to assign'}
        </Typography>
      )}

      {/* Rerun button */}
      <Button
        size="small"
        variant="outlined"
        startIcon={rerunLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
        onClick={() => void rerun()}
        disabled={rerunLoading}
      >
        Re-run face detection
      </Button>

      {/* People in this photo — manual association editor */}
      {canAssign && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            People in this photo
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Add people who appear in this photo — no need to mark where.
          </Typography>
          {/* Existing manual people as deletable chips */}
          {manualFaces.length > 0 && (
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', mb: 1 }}>
              {manualFaces
                .filter((f, idx, arr) => arr.findIndex((ff) => ff.personId === f.personId) === idx)
                .map((f) => (
                  <Chip
                    key={f.personId ?? f.id}
                    label={f.personName ?? 'Unnamed'}
                    size="small"
                    onDelete={() => f.personId && void handleRemovePerson(f.personId)}
                    disabled={removingPersonId === f.personId || addingPerson}
                  />
                ))}
            </Stack>
          )}
          {/* Autocomplete to add a person */}
          <Autocomplete<PersonListItem | string, false, false, true>
            freeSolo
            options={peopleSuggestions}
            getOptionLabel={(opt) =>
              typeof opt === 'string' ? opt : (opt.name ?? 'Unlabeled')
            }
            value={null}
            inputValue={personInputValue}
            onInputChange={(_, val) => setPersonInputValue(val)}
            onChange={(_, selected) => {
              if (!selected) return;
              if (typeof selected === 'string') {
                void handleAddPerson(undefined, selected);
              } else {
                void handleAddPerson((selected as PersonListItem).id);
              }
            }}
            disabled={addingPerson}
            size="small"
            renderInput={(params) => (
              <TextField
                {...params}
                label="Add a person"
                placeholder="Type name or pick existing"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && personInputValue.trim()) {
                    void handleAddPerson(undefined, personInputValue);
                  }
                }}
                slotProps={{
                  ...params.slotProps,
                  input: {
                    ...params.slotProps.input,
                    endAdornment: addingPerson ? <CircularProgress size={14} /> : params.slotProps.input?.endAdornment,
                  },
                }}
              />
            )}
          />
          {manualPeopleError && (
            <Alert severity="error" sx={{ mt: 1 }} onClose={() => setManualPeopleError(null)}>
              {manualPeopleError}
            </Alert>
          )}
        </Box>
      )}

      {/* Assign dialog */}
      {circleId && (
        <AssignFaceDialog
          open={assignDialogFace !== null}
          face={assignDialogFace}
          imageUrl={downloadUrl ?? thumbnailUrl}
          circleId={circleId}
          onClose={() => setAssignDialogFace(null)}
          onSuccess={() => void refresh()}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// FaceBox — individual face bounding box overlay
// ---------------------------------------------------------------------------

function FaceBox({
  face,
  theme,
  clickable,
  onClick,
}: {
  face: DetectedFaceDto;
  theme: Theme;
  clickable?: boolean;
  onClick?: () => void;
}) {
  const { x, y, w, h } = face.boundingBox;
  const confidenceLabel =
    face.confidence !== null
      ? `${Math.round(face.confidence * 100)}% confidence`
      : 'Face detected';

  const label = face.personId ? (face.personName ?? 'Assigned') : 'Unassigned';

  return (
    <Tooltip
      title={clickable ? `${confidenceLabel} · click to assign` : confidenceLabel}
      placement="top"
    >
      <Box
        onClick={onClick}
        sx={{
          position: 'absolute',
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: `${w * 100}%`,
          height: `${h * 100}%`,
          border: `2px solid ${theme.palette.secondary.main}`,
          boxSizing: 'border-box',
          cursor: clickable ? 'pointer' : 'default',
          '&:hover': {
            borderColor: theme.palette.secondary.light,
            backgroundColor: `${theme.palette.secondary.main}22`,
          },
        }}
      >
        <Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
          <Chip
            label={label}
            size="small"
            sx={{
              height: 16,
              fontSize: '0.6rem',
              opacity: 0.85,
              backgroundColor: face.personId
                ? theme.palette.success.main
                : theme.palette.grey[700],
              color: 'white',
              borderRadius: 0.5,
            }}
          />
        </Box>
      </Box>
    </Tooltip>
  );
}
