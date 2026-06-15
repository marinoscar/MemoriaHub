import { useState, useCallback, useEffect } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Divider,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  Stack,
  Chip,
  useMediaQuery,
} from '@mui/material';
import {
  Close as CloseIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  Edit as EditIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Download as DownloadIcon,
  BrokenImage as BrokenImageIcon,
  AddLocation as AddLocationIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { MediaItem, MediaClassification, PatchMediaDto } from '../../types/media';
import { patchMedia as patchMediaApi, getMedia, bulkUpdateMedia, bulkTags } from '../../services/media';
import { VideoPlayer } from './VideoPlayer';
import { LocationMiniMap } from './LocationMiniMap';
import { LocationPickerMap } from './LocationPickerMap';
import { TagAutocomplete } from './TagAutocomplete';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <Box sx={{ display: 'flex', gap: 1, py: 0.25 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 120, fontWeight: 500 }}
      >
        {label}
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
        {String(value)}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaDetailDrawerProps {
  item: MediaItem | null;
  open: boolean;
  onClose: () => void;
  onItemUpdated: (updated: MediaItem) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaDetailDrawer({
  item,
  open,
  onClose,
  onItemUpdated,
}: MediaDetailDrawerProps) {
  const theme = useTheme();
  const isSmall = useMediaQuery(theme.breakpoints.down('sm'));

  // Full item fetched from GET /api/media/:id (has downloadUrl)
  const [fullItem, setFullItem] = useState<MediaItem | null>(null);

  // Editable field state
  const [editing, setEditing] = useState(false);
  const [editCapturedAt, setEditCapturedAt] = useState('');
  const [editClassification, setEditClassification] = useState<MediaClassification>('unreviewed');
  const [editTitle, setEditTitle] = useState('');
  const [editCaption, setEditCaption] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Image load state
  const [imgError, setImgError] = useState(false);

  // Location edit state
  const [locationEditOpen, setLocationEditOpen] = useState(false);
  const [editPinLocation, setEditPinLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationSaving, setLocationSaving] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // Tag edit state
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const [editTagsAdd, setEditTagsAdd] = useState<string[]>([]);
  const [editTagsRemove, setEditTagsRemove] = useState<string[]>([]);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagSuccess, setTagSuccess] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch full item (with downloadUrl) when drawer opens for a new item.
  // The list endpoint does not populate downloadUrl; only GET /media/:id does.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open || !item) {
      setFullItem(null);
      setLocationEditOpen(false);
      setTagEditOpen(false);
      setEditTagsAdd([]);
      setEditTagsRemove([]);
      setTagSuccess(null);
      return;
    }
    // If the list item already carries downloadUrl (e.g. after an edit), skip fetch.
    if (item.downloadUrl !== undefined) {
      setFullItem(item);
      return;
    }

    let cancelled = false;
    const requestedId = item.id;

    getMedia(requestedId)
      .then((fetched) => {
        if (!cancelled && fetched.id === requestedId) {
          setFullItem(fetched);
        }
      })
      .catch(() => {
        // Silently swallow — displayItem falls back to the list item.
      });

    return () => {
      cancelled = true;
    };
  }, [item?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartEdit = useCallback(() => {
    if (!item) return;
    setEditCapturedAt(item.capturedAt ? item.capturedAt.slice(0, 16) : '');
    setEditClassification(item.classification);
    setEditTitle(item.title ?? '');
    setEditCaption(item.caption ?? '');
    setEditDescription(item.description ?? '');
    setSaveError(null);
    setEditing(true);
  }, [item]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!item) return;
    setSaving(true);
    setSaveError(null);
    try {
      const dto: PatchMediaDto = {
        capturedAt: editCapturedAt ? new Date(editCapturedAt).toISOString() : null,
        classification: editClassification,
        title: editTitle || null,
        caption: editCaption || null,
        description: editDescription || null,
      };
      const updated = await patchMediaApi(item.id, dto);
      // Keep fullItem consistent with the saved data so edits persist in the drawer.
      if (fullItem) {
        setFullItem({ ...fullItem, ...updated });
      }
      onItemUpdated(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }, [
    item,
    fullItem,
    editCapturedAt,
    editClassification,
    editTitle,
    editCaption,
    editDescription,
    onItemUpdated,
  ]);

  const handleSaveLocation = useCallback(async () => {
    if (!item || !editPinLocation) return;
    setLocationSaving(true);
    setLocationError(null);
    try {
      await bulkUpdateMedia({
        circleId: item.circleId,
        ids: [item.id],
        set: { location: { lat: editPinLocation.lat, lng: editPinLocation.lng } },
      });
      const refreshed = await getMedia(item.id);
      setFullItem(refreshed);
      onItemUpdated(refreshed);
      setLocationEditOpen(false);
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to save location');
    } finally {
      setLocationSaving(false);
    }
  }, [item, editPinLocation, onItemUpdated]);

  const handleSaveTags = useCallback(async () => {
    if (!item) return;
    if (editTagsAdd.length === 0 && editTagsRemove.length === 0) return;
    setTagSaving(true);
    setTagError(null);
    try {
      await bulkTags({
        circleId: item.circleId,
        ids: [item.id],
        add: editTagsAdd.length > 0 ? editTagsAdd : undefined,
        remove: editTagsRemove.length > 0 ? editTagsRemove : undefined,
      });
      const refreshed = await getMedia(item.id);
      setFullItem(refreshed);
      onItemUpdated(refreshed);
      setEditTagsAdd([]);
      setEditTagsRemove([]);
      setTagEditOpen(false);
      setTagSuccess('Tags updated');
    } catch (err) {
      setTagError(err instanceof Error ? err.message : 'Failed to update tags');
    } finally {
      setTagSaving(false);
    }
  }, [item, editTagsAdd, editTagsRemove, onItemUpdated]);

  const handleToggleFavorite = useCallback(async () => {
    if (!item) return;
    try {
      const updated = await patchMediaApi(item.id, { favorite: !item.favorite });
      onItemUpdated(updated);
    } catch {
      // Silently fail — the UI won't update since onItemUpdated won't be called
    }
  }, [item, onItemUpdated]);

  if (!item) return null;

  // Use the full item (with downloadUrl) when available; fall back to the list item.
  const displayItem = fullItem ?? item;

  const previewUrl = displayItem.thumbnailUrl ?? (displayItem.downloadUrl ?? null);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      variant="temporary"
      ModalProps={{ keepMounted: false }}
      sx={{
        '& .MuiDrawer-paper': {
          width: isSmall ? '100vw' : 440,
          maxWidth: '100vw',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 2,
          py: 1,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <IconButton onClick={onClose} size="small" aria-label="Close detail panel">
          <CloseIcon />
        </IconButton>
        <Typography variant="h6" sx={{ ml: 1, flex: 1 }} noWrap>
          {item.title ?? item.originalFilename}
        </Typography>

        {/* Favorite toggle */}
        <Tooltip title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}>
          <IconButton onClick={handleToggleFavorite} aria-label="Toggle favorite">
            {item.favorite ? (
              <StarIcon sx={{ color: theme.palette.warning.main }} />
            ) : (
              <StarBorderIcon />
            )}
          </IconButton>
        </Tooltip>

        {/* Download link — only shown once the full item (with signed URL) is loaded */}
        {displayItem.downloadUrl && (
          <Tooltip title="Download original">
            <IconButton
              component="a"
              href={displayItem.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download original file"
            >
              <DownloadIcon />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Preview — branches on media type */}
      {displayItem.type === 'video' ? (
        /*
         * Video branch:
         *   - downloadUrl available → full Vidstack player (16:9 ratio, no fixed height)
         *   - downloadUrl not yet fetched → centered spinner
         */
        displayItem.downloadUrl ? (
          <Box sx={{ width: '100%', flexShrink: 0, backgroundColor: 'black' }}>
            <VideoPlayer
              src={displayItem.downloadUrl}
              poster={displayItem.thumbnailUrl}
              title={displayItem.title ?? displayItem.originalFilename}
            />
          </Box>
        ) : (
          <Box
            sx={{
              backgroundColor: theme.palette.grey[900],
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              flexShrink: 0,
              height: 240,
            }}
          >
            <CircularProgress size={40} />
          </Box>
        )
      ) : (
        /*
         * Photo branch — existing image display with error fallback.
         */
        <Box
          sx={{
            backgroundColor: theme.palette.grey[900],
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            flexShrink: 0,
            height: 240,
            overflow: 'hidden',
          }}
        >
          {previewUrl && !imgError ? (
            <Box
              component="img"
              src={previewUrl}
              alt={item.title ?? item.originalFilename}
              onError={() => setImgError(true)}
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
              }}
            />
          ) : (
            <Box sx={{ textAlign: 'center', color: theme.palette.grey[500] }}>
              <BrokenImageIcon sx={{ fontSize: 64 }} />
              <Typography variant="caption" sx={{ display: 'block' }}>
                Image not available
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {/* Scrollable content */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 2, py: 1.5 }}>
        {/* Edit / Save controls */}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
          {!editing ? (
            <Button size="small" startIcon={<EditIcon />} onClick={handleStartEdit}>
              Edit
            </Button>
          ) : (
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                startIcon={<CancelIcon />}
                onClick={handleCancelEdit}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon />}
                onClick={handleSave}
                disabled={saving}
              >
                Save
              </Button>
            </Stack>
          )}
        </Box>

        {saveError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {saveError}
          </Alert>
        )}

        {/* Editable fields */}
        {editing ? (
          <Stack spacing={2}>
            <TextField
              label="Title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              size="small"
              fullWidth
            />
            <TextField
              label="Caption"
              value={editCaption}
              onChange={(e) => setEditCaption(e.target.value)}
              size="small"
              fullWidth
              multiline
              rows={2}
            />
            <TextField
              label="Description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              size="small"
              fullWidth
              multiline
              rows={3}
            />
            <TextField
              label="Captured At"
              type="datetime-local"
              value={editCapturedAt}
              onChange={(e) => setEditCapturedAt(e.target.value)}
              size="small"
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <FormControl size="small" fullWidth>
              <InputLabel id="classification-label">Classification</InputLabel>
              <Select
                labelId="classification-label"
                label="Classification"
                value={editClassification}
                onChange={(e) =>
                  setEditClassification(e.target.value as MediaClassification)
                }
              >
                <MenuItem value="memory">Memory</MenuItem>
                <MenuItem value="low_value">Low Value</MenuItem>
                <MenuItem value="unreviewed">Unreviewed</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        ) : (
          <>
            {/* Read-only view of editable fields */}
            {item.title && (
              <Typography variant="subtitle2" gutterBottom>
                {item.title}
              </Typography>
            )}
            {item.caption && (
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {item.caption}
              </Typography>
            )}
            {item.description && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {item.description}
              </Typography>
            )}
          </>
        )}

        <Divider sx={{ my: 1.5 }} />

        {/* Classification chip (read-only mode) */}
        {!editing && (
          <Box sx={{ mb: 1 }}>
            <Chip
              label={item.classification}
              size="small"
              color={
                item.classification === 'memory'
                  ? 'primary'
                  : item.classification === 'low_value'
                    ? 'default'
                    : 'warning'
              }
              variant="outlined"
            />
          </Box>
        )}

        {/* Metadata */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5 }}
        >
          Details
        </Typography>

        <MetaRow label="Type" value={item.type} />
        <MetaRow label="Captured" value={formatDateTime(item.capturedAt)} />
        <MetaRow label="Imported" value={formatDateTime(item.importedAt)} />
        <MetaRow label="Source" value={item.source} />
        <MetaRow
          label="Dimensions"
          value={item.width && item.height ? `${item.width} × ${item.height}` : null}
        />
        <MetaRow label="Duration" value={item.type === 'video' ? formatDuration(item.durationMs) : null} />
        <MetaRow label="Orientation" value={item.orientation} />

        {(item.takenLat !== null || item.takenLng !== null) && (
          <MetaRow
            label="GPS"
            value={
              item.takenLat !== null && item.takenLng !== null
                ? `${item.takenLat.toFixed(6)}, ${item.takenLng.toFixed(6)}`
                : null
            }
          />
        )}
        <MetaRow label="Altitude" value={item.takenAltitude !== null ? `${item.takenAltitude} m` : null} />
        <MetaRow label="Camera" value={[item.cameraMake, item.cameraModel].filter(Boolean).join(' ')} />
        <MetaRow label="Content Hash" value={item.contentHash} />
        <MetaRow label="Filename" value={item.originalFilename} />

        {/* Geo fields + mini-map */}
        {(item.geoCountry || item.geoAdmin1 || item.geoLocality || item.geoPlaceName) && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              Location
            </Typography>
            <MetaRow label="Country" value={item.geoCountry} />
            <MetaRow label="Region" value={item.geoAdmin1} />
            <MetaRow label="Sub-region" value={item.geoAdmin2} />
            <MetaRow label="City" value={item.geoLocality} />
            <MetaRow label="Place" value={item.geoPlaceName} />
            <MetaRow label="Geo Source" value={item.geoSource} />
          </>
        )}

        {/* Edit Location affordance */}
        <Box sx={{ mt: 1, mb: 0.5 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddLocationIcon />}
            onClick={() => {
              setEditPinLocation(
                displayItem.takenLat !== null && displayItem.takenLng !== null
                  ? { lat: displayItem.takenLat, lng: displayItem.takenLng }
                  : null,
              );
              setLocationEditOpen(true);
            }}
          >
            {displayItem.takenLat !== null ? 'Edit Location' : 'Set Location'}
          </Button>
        </Box>

        {/* Inline location editor */}
        {locationEditOpen && (
          <Box sx={{ mt: 1 }}>
            <LocationPickerMap
              value={editPinLocation}
              onChange={setEditPinLocation}
              height={220}
            />
            {locationError && <Alert severity="error" sx={{ mt: 1 }}>{locationError}</Alert>}
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button size="small" onClick={() => setLocationEditOpen(false)} disabled={locationSaving}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => void handleSaveLocation()}
                disabled={!editPinLocation || locationSaving}
                startIcon={locationSaving ? <CircularProgress size={12} /> : undefined}
              >
                Save Location
              </Button>
            </Stack>
          </Box>
        )}

        {/* Mini-map — shown when GPS coordinates are present and not editing */}
        {!locationEditOpen && displayItem.takenLat !== null && displayItem.takenLng !== null && (
          <Box sx={{ mt: 1.5 }}>
            <LocationMiniMap
              lat={displayItem.takenLat}
              lng={displayItem.takenLng}
              label={displayItem.geoPlaceName ?? displayItem.geoLocality}
            />
          </Box>
        )}

        {/* Tags */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Tags
        </Typography>

        {displayItem.tags && displayItem.tags.length > 0 ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
            {displayItem.tags.map((tag) => (
              <Chip key={tag} label={tag} size="small" variant="outlined" />
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>No tags</Typography>
        )}

        {tagSuccess && (
          <Alert severity="success" sx={{ mb: 1 }} onClose={() => setTagSuccess(null)}>{tagSuccess}</Alert>
        )}

        {!tagEditOpen ? (
          <Button size="small" variant="outlined" onClick={() => setTagEditOpen(true)}>
            Edit Tags
          </Button>
        ) : (
          <Stack spacing={1.5}>
            <TagAutocomplete
              label="Add tags"
              value={editTagsAdd}
              onChange={setEditTagsAdd}
              circleId={item?.circleId}
              disabled={tagSaving}
            />
            <TagAutocomplete
              label="Remove tags"
              value={editTagsRemove}
              onChange={setEditTagsRemove}
              circleId={item?.circleId}
              disabled={tagSaving}
            />
            {tagError && <Alert severity="error">{tagError}</Alert>}
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                onClick={() => {
                  setTagEditOpen(false);
                  setEditTagsAdd([]);
                  setEditTagsRemove([]);
                  setTagError(null);
                }}
                disabled={tagSaving}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => void handleSaveTags()}
                disabled={(editTagsAdd.length === 0 && editTagsRemove.length === 0) || tagSaving}
                startIcon={tagSaving ? <CircularProgress size={12} /> : undefined}
              >
                Save Tags
              </Button>
            </Stack>
          </Stack>
        )}

        {/* Timestamps */}
        <Divider sx={{ my: 1.5 }} />
        <MetaRow label="Created" value={formatDateTime(item.createdAt)} />
        <MetaRow label="Updated" value={formatDateTime(item.updatedAt)} />
      </Box>
    </Drawer>
  );
}
