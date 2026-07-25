/**
 * AssignFaceDialog — shared dialog for assigning, reassigning, unassigning, or
 * permanently deleting a detected face (or a set of detected faces).
 *
 * Used by FaceThumbnails (photos — a single face crop) and VideoFacePanel
 * (videos — a representative face row that stands in for every detected face of
 * the same person). Pass `faceIds` to operate on a whole set; when omitted the
 * dialog operates on the single `face.id`, preserving the original photo
 * behavior.
 */

import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Autocomplete,
  Divider,
  Avatar,
} from '@mui/material';
import type { DetectedFaceDto } from '../../services/face';
import {
  listPeople,
  createPerson,
  assignFaces,
  unassignFace,
  purgeFaces,
} from '../../services/face';
import type { PersonListItem } from '../../services/face';
import { FaceCrop } from '../people/FaceCrop';
import { PurgeFacesDialog } from '../people/PurgeFacesDialog';

interface AssignFaceDialogProps {
  open: boolean;
  face: DetectedFaceDto | null;
  /** Full-resolution URL preferred; falls back to thumbnailUrl for sharp crop preview.
   *  Omit for videos — the representative-frame thumbnail is used instead. */
  imageUrl?: string;
  circleId: string;
  /** When provided, all actions operate on this full set of face IDs (e.g. every
   *  detected face for a person in a video). Defaults to the single `face.id`. */
  faceIds?: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function AssignFaceDialog({
  open,
  face,
  imageUrl,
  circleId,
  faceIds,
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
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
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
      setShowPurgeConfirm(false);
      setError(null);
    }
  }, [open]);

  if (!face) return null;
  const isAssigned = face.personId !== null;
  const targetFaceIds = faceIds ?? (face ? [face.id] : []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPerson({ circleId, name: newName.trim(), faceIds: targetFaceIds });
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
      await assignFaces(selectedPerson.id, targetFaceIds);
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
      await Promise.all(targetFaceIds.map((id) => unassignFace(face.personId!, id)));
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
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      sx={{ zIndex: (theme) => theme.zIndex.modal + 2 }}
    >
      <DialogTitle>
        {isAssigned ? 'Reassign or Unassign Face' : 'Assign Face to Person'}
      </DialogTitle>
      <DialogContent>
        {/* Face preview — video uses the pre-cropped representative frame directly,
            photos crop the full-res image to the bounding box. */}
        {face.faceThumbnailUrl ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <Avatar
              src={face.faceThumbnailUrl}
              variant="rounded"
              sx={{ width: 96, height: 96 }}
            />
          </Box>
        ) : (
          imageUrl && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <FaceCrop imageUrl={imageUrl} boundingBox={face.boundingBox} size={96} />
            </Box>
          )
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
          slotProps={{ popper: { sx: { zIndex: (theme) => theme.zIndex.modal + 3 } } }}
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

        {/* Permanent deletion — available whether assigned or not */}
        <Divider sx={{ my: 2 }}>
          <Typography variant="caption">or</Typography>
        </Divider>
        <Button
          fullWidth
          variant="outlined"
          color="error"
          onClick={() => setShowPurgeConfirm(true)}
          disabled={assigning || unassigning || creating}
        >
          Delete detection permanently
        </Button>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>

      {/* Confirm permanent deletion */}
      <PurgeFacesDialog
        open={showPurgeConfirm}
        count={targetFaceIds.length}
        onClose={() => setShowPurgeConfirm(false)}
        onConfirm={async () => {
          await purgeFaces(circleId, targetFaceIds);
          onSuccess();
          onClose();
        }}
      />
    </Dialog>
  );
}
