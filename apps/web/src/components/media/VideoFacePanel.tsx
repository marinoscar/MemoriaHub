/**
 * VideoFacePanel — "People in this video" section for video MediaItems.
 *
 * Groups detected faces by personId (one row per person; unassigned faces each
 * get their own row). Shows a face crop from the representative frame, the
 * person name, and an optional "jump-to" button that seeks the video to the
 * representative timestamp.
 *
 * Also provides the same manual people-association Autocomplete that
 * FaceThumbnails uses for photos, so users can tag who appears in a video even
 * when automatic face detection misses someone.
 */

import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Chip,
  Button,
  Alert,
  Avatar,
  Tooltip,
  Skeleton,
  Stack,
  IconButton,
  TextField,
  Autocomplete,
  CircularProgress,
} from '@mui/material';
import FaceIcon from '@mui/icons-material/Face';
import RefreshIcon from '@mui/icons-material/Refresh';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import PersonIcon from '@mui/icons-material/Person';
import EditIcon from '@mui/icons-material/Edit';
import { useMediaFaces } from '../../hooks/useMediaFaces';
import type { MediaFaceStatusType, DetectedFaceDto } from '../../services/face';
import {
  listPeople,
  addPersonToMedia,
  removePersonFromMedia,
} from '../../services/face';
import type { PersonListItem } from '../../services/face';
import { PersonAvatar } from '../people/PersonAvatar';
import { AssignFaceDialog } from './AssignFaceDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Format a millisecond timestamp as "m:ss.mmm" (e.g. "1:23.456").
 */
function formatTimestamp(ms: number): string {
  const totalMs = Math.round(ms);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Deduplication helper
// ---------------------------------------------------------------------------

/**
 * Groups faces by personId (non-null) or leaves unassigned faces as individual
 * entries. Within each group, picks the face with the earliest videoTimestampMs
 * as the representative.
 */
function deduplicateFaces(faces: DetectedFaceDto[]): DetectedFaceDto[] {
  const byPerson = new Map<string, DetectedFaceDto>();
  const unassigned: DetectedFaceDto[] = [];

  for (const face of faces) {
    if (face.personId === null) {
      unassigned.push(face);
      continue;
    }
    const existing = byPerson.get(face.personId);
    if (!existing) {
      byPerson.set(face.personId, face);
      continue;
    }
    // Keep the face with the earliest representative timestamp
    const existingTs = existing.videoTimestampMs ?? Infinity;
    const currentTs = face.videoTimestampMs ?? Infinity;
    if (currentTs < existingTs) {
      byPerson.set(face.personId, face);
    }
  }

  return [...byPerson.values(), ...unassigned];
}

/**
 * Builds a map of personId → all detected face IDs for that person, from the
 * pre-dedup detected-face array. Used so an edit action on a representative row
 * can operate on every detected face of that person (a person may be observed
 * across many sampled frames, each a separate Face row).
 */
function buildPersonFaceIds(faces: DetectedFaceDto[]): Map<string, string[]> {
  const byPerson = new Map<string, string[]>();
  for (const face of faces) {
    if (face.personId === null) continue;
    const existing = byPerson.get(face.personId);
    if (existing) {
      existing.push(face.id);
    } else {
      byPerson.set(face.personId, [face.id]);
    }
  }
  return byPerson;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VideoFacePanelProps {
  mediaId: string;
  circleId?: string;
  /** Video duration in milliseconds from MediaItem.durationMs. */
  durationMs: number | null;
  /** Called when the user clicks the jump-to-timestamp button. Seconds from start. */
  onSeek?: (seconds: number) => void;
  /** ID of the currently selected face row (for highlight). */
  selectedFaceId?: string | null;
  onSelectFace?: (faceId: string | null) => void;
  /** Called after any face mutation so an external face consumer (e.g. the
   *  marker strip) can refresh its own copy of the faces. */
  onFacesChanged?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoFacePanel({
  mediaId,
  circleId,
  onSeek,
  selectedFaceId,
  onSelectFace,
  onFacesChanged,
}: VideoFacePanelProps) {
  const { faces, status, loading, error, rerun, rerunLoading, refresh } =
    useMediaFaces(mediaId);

  // Manual people state (mirrors FaceThumbnails)
  const [peopleSuggestions, setPeopleSuggestions] = useState<PersonListItem[]>([]);
  const [addingPerson, setAddingPerson] = useState(false);
  const [removingPersonId, setRemovingPersonId] = useState<string | null>(null);
  const [manualPeopleError, setManualPeopleError] = useState<string | null>(null);
  const [personInputValue, setPersonInputValue] = useState('');

  // Edit-face dialog (assign / reassign / unassign / delete a detected face)
  const [editFace, setEditFace] = useState<DetectedFaceDto | null>(null);

  const canAssign = Boolean(circleId);

  // Load people suggestions when circleId is available
  useEffect(() => {
    if (!circleId || !canAssign) return;
    listPeople(circleId, { pageSize: 100 })
      .then((res) => setPeopleSuggestions(res.items.filter((p) => p.name != null)))
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
      onFacesChanged?.();
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
      onFacesChanged?.();
    } catch (err) {
      setManualPeopleError(err instanceof Error ? err.message : 'Failed to remove person');
    } finally {
      setRemovingPersonId(null);
    }
  };

  if (loading) {
    return <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 1 }} />;
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 1 }}>
        {error}
      </Alert>
    );
  }

  const chipProps = status
    ? statusChipProps(status.status)
    : { label: 'Not Processed', color: 'default' as const };

  // Separate manual associations from detected faces for the chip display
  const manualFaces = faces.filter((f) => f.providerKey === 'manual');
  const detectedFaces = faces.filter((f) => f.providerKey !== 'manual');
  const dedupedFaces = deduplicateFaces(detectedFaces);
  const personFaceIds = buildPersonFaceIds(detectedFaces);

  // Resolve every detected face ID a representative row stands for: for an
  // unassigned face just the face itself, otherwise all of its person's faces.
  const resolvedFaceIdsFor = (face: DetectedFaceDto): string[] =>
    face.personId === null ? [face.id] : personFaceIds.get(face.personId) ?? [face.id];

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

      {/* Detection error detail */}
      {status?.status === 'failed' && status.lastError && (
        <Alert severity="error" sx={{ mt: 1, mb: 1 }}>
          {status.lastError}
        </Alert>
      )}

      {/* Rerun button */}
      <Button
        size="small"
        variant="outlined"
        startIcon={rerunLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
        onClick={() => void rerun()}
        disabled={rerunLoading}
        sx={{ mb: 1.5 }}
      >
        Re-run face detection
      </Button>

      {/* People in this video — detected face rows */}
      {dedupedFaces.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            People in this video
          </Typography>
          <Stack spacing={0.5}>
            {dedupedFaces.map((face) => {
              const isSelected = selectedFaceId === face.id;
              const hasTimestamp = face.videoTimestampMs !== null;
              const hasThumbnail = Boolean(face.faceThumbnailUrl);

              return (
                <Box
                  key={face.id}
                  onClick={() => onSelectFace?.(isSelected ? null : face.id)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1,
                    py: 0.75,
                    borderRadius: 1,
                    cursor: 'pointer',
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: isSelected ? 'action.selected' : 'action.hover' },
                    transition: 'background-color 0.15s',
                  }}
                >
                  {/* Face thumbnail or placeholder avatar */}
                  {hasThumbnail ? (
                    // faceThumbnailUrl is an already-cropped representative-frame JPEG —
                    // do NOT re-apply bounding-box crop math (FaceCrop would produce a
                    // double-crop artifact). Render it directly as a rounded avatar.
                    <Avatar
                      src={face.faceThumbnailUrl!}
                      variant="rounded"
                      sx={{ width: 56, height: 56 }}
                    />
                  ) : (
                    <Avatar sx={{ width: 56, height: 56, bgcolor: 'grey.300' }} variant="rounded">
                      <PersonIcon sx={{ color: 'grey.600' }} />
                    </Avatar>
                  )}

                  {/* Name + sub-info */}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {face.personName ?? 'Unassigned'}
                    </Typography>
                    {face.confidence !== null && (
                      <Typography variant="caption" color="text.secondary">
                        {Math.round(face.confidence * 100)}% confidence
                      </Typography>
                    )}
                  </Box>

                  {/* Edit face — assign / reassign / unassign / delete */}
                  {canAssign && (
                    <Tooltip title="Edit face">
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditFace(face);
                        }}
                        aria-label="Edit face"
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}

                  {/* Jump-to-timestamp button */}
                  {hasTimestamp && onSeek && (
                    <Tooltip title={`Jump to ${formatTimestamp(face.videoTimestampMs!)}`}>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSeek(face.videoTimestampMs! / 1000);
                        }}
                        aria-label={`Seek to ${formatTimestamp(face.videoTimestampMs!)}`}
                      >
                        <AccessTimeIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Box>
      )}

      {/* Manual people-association section */}
      {canAssign && (
        <Box sx={{ mt: dedupedFaces.length > 0 ? 0 : 0.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {dedupedFaces.length > 0 ? 'Also tag people manually' : 'Tag people in this video'}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Add people who appear in this video — no bounding box needed.
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
            openOnFocus
            options={peopleSuggestions}
            getOptionLabel={(opt) =>
              typeof opt === 'string' ? opt : (opt.name ?? '')
            }
            isOptionEqualToValue={(option, val) =>
              typeof option === 'string' || typeof val === 'string'
                ? option === val
                : option.id === (val as PersonListItem).id
            }
            renderOption={(props, option) => {
              if (typeof option === 'string') return null;
              return (
                <Box
                  component="li"
                  {...props}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                >
                  <PersonAvatar person={option} size={28} />
                  <Typography variant="body2">{option.name}</Typography>
                </Box>
              );
            }}
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
            slotProps={{ popper: { sx: { zIndex: (theme) => theme.zIndex.modal + 2 } } }}
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
                    endAdornment: addingPerson
                      ? <CircularProgress size={14} />
                      : params.slotProps.input?.endAdornment,
                  },
                }}
              />
            )}
          />

          {manualPeopleError && (
            <Alert
              severity="error"
              sx={{ mt: 1 }}
              onClose={() => setManualPeopleError(null)}
            >
              {manualPeopleError}
            </Alert>
          )}
        </Box>
      )}

      {/* Edit-face dialog — video faces use the representative-frame thumbnail
          preview (no imageUrl passed). */}
      {circleId && (
        <AssignFaceDialog
          open={editFace !== null}
          face={editFace}
          circleId={circleId}
          faceIds={editFace ? resolvedFaceIdsFor(editFace) : []}
          onClose={() => setEditFace(null)}
          onSuccess={() => {
            void refresh();
            onFacesChanged?.();
          }}
        />
      )}
    </Box>
  );
}
