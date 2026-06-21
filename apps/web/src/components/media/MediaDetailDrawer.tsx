import { useState, useCallback, useEffect } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Divider,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  Stack,
  Chip,
  useMediaQuery,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
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
  LocalOffer as LocalOfferIcon,
  Refresh as RefreshIcon,
  InfoOutlined as InfoOutlinedIcon,
  Archive as ArchiveIcon,
  Unarchive as UnarchiveIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { MediaItem, PatchMediaDto } from '../../types/media';
import {
  patchMedia as patchMediaApi,
  getMedia,
  bulkUpdateMedia,
  bulkTags,
  bulkArchive,
  bulkUnarchive,
  bulkDelete,
} from '../../services/media';
import { VideoPlayer } from './VideoPlayer';
import { LocationMiniMap } from './LocationMiniMap';
import { LocationPickerMap } from './LocationPickerMap';
import { TagAutocomplete } from './TagAutocomplete';
import { FaceThumbnails } from './FaceThumbnails';
import { useMediaTags } from '../../hooks/useMediaTags';
import type { MediaTagStatusType } from '../../services/tagging';
import { useMediaMetadata } from '../../hooks/useMediaMetadata';
import type { MediaMetadataStatusType } from '../../services/metadata';

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

function tagStatusChipProps(status: MediaTagStatusType | undefined): {
  label: string;
  color: 'success' | 'warning' | 'info' | 'default' | 'error';
} {
  switch (status) {
    case 'processed':
      return { label: 'Tagged', color: 'success' };
    case 'pending':
      return { label: 'Pending', color: 'warning' };
    case 'processing':
      return { label: 'Processing', color: 'info' };
    case 'failed':
      return { label: 'Failed', color: 'error' };
    default:
      return { label: 'Not Tagged', color: 'default' };
  }
}

function metadataStatusChipProps(status: MediaMetadataStatusType | undefined): {
  label: string;
  color: 'success' | 'warning' | 'info' | 'default' | 'error';
} {
  switch (status) {
    case 'processed':
      return { label: 'Extracted', color: 'success' };
    case 'pending':
      return { label: 'Pending', color: 'warning' };
    case 'processing':
      return { label: 'Processing', color: 'info' };
    case 'failed':
      return { label: 'Failed', color: 'error' };
    default:
      return { label: 'Not Extracted', color: 'default' };
  }
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
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: { xs: 0, sm: 1 }, py: 0.25 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: { sm: 120 }, fontWeight: 500 }}
      >
        {label}
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: 'break-word' }}>
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
  const [editDescription, setEditDescription] = useState('');

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Archive / delete state
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const handleToggleArchive = useCallback(async () => {
    if (!item) return;
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      const isArchived = item.archivedAt !== null;
      if (isArchived) {
        await bulkUnarchive({ circleId: item.circleId, ids: [item.id] });
      } else {
        await bulkArchive({ circleId: item.circleId, ids: [item.id] });
      }
      const refreshed = await getMedia(item.id);
      setFullItem(refreshed);
      onItemUpdated(refreshed);
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Failed to update archive state');
    } finally {
      setArchiveLoading(false);
    }
  }, [item, onItemUpdated]);

  const handleDelete = useCallback(async () => {
    if (!item) return;
    setDeleteConfirmOpen(false);
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await bulkDelete({ circleId: item.circleId, ids: [item.id] });
      onClose();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to move item to Trash');
    } finally {
      setDeleteLoading(false);
    }
  }, [item, onClose]);

  const handleToggleFavorite = useCallback(async () => {
    if (!item) return;
    try {
      const updated = await patchMediaApi(item.id, { favorite: !item.favorite });
      onItemUpdated(updated);
    } catch {
      // Silently fail — the UI won't update since onItemUpdated won't be called
    }
  }, [item, onItemUpdated]);

  // Callback that refreshes the full item after a tagging rerun completes
  const onRefreshTags = useCallback(async () => {
    if (!item) return;
    try {
      const refreshed = await getMedia(item.id);
      setFullItem(refreshed);
      onItemUpdated(refreshed);
    } catch {
      // Silently swallow — tags display will still update via status
    }
  }, [item?.id, onItemUpdated]); // eslint-disable-line react-hooks/exhaustive-deps

  const { status: tagStatus, rerun: rerunTags, rerunLoading: rerunTagsLoading } = useMediaTags(
    item?.id ?? '',
    onRefreshTags,
  );

  const { status: metadataStatus, rerun: rerunMetadata, rerunLoading: rerunMetadataLoading } = useMediaMetadata(
    item?.id ?? '',
    onRefreshTags,
  );

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
        zIndex: (theme: Theme) => theme.zIndex.modal + 1,
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
          {item.originalFilename}
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
              title={displayItem.originalFilename}
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
              alt={item.originalFilename}
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
                sx={{ minHeight: 44 }}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon />}
                onClick={handleSave}
                disabled={saving}
                sx={{ minHeight: 44 }}
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
          </Stack>
        ) : (
          <>
            {/* Read-only view of editable fields */}
            {item.description && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {item.description}
              </Typography>
            )}
          </>
        )}

        <Divider sx={{ my: 1.5 }} />

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
            sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
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
              <Button size="small" onClick={() => setLocationEditOpen(false)} disabled={locationSaving} sx={{ minHeight: 44 }}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => void handleSaveLocation()}
                disabled={!editPinLocation || locationSaving}
                startIcon={locationSaving ? <CircularProgress size={12} /> : undefined}
                sx={{ minHeight: 44 }}
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

        {/* People / Faces */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          People / Faces
        </Typography>
        <FaceThumbnails
          mediaId={displayItem.id}
          mediaType={displayItem.type}
          thumbnailUrl={displayItem.thumbnailUrl ?? undefined}
          downloadUrl={displayItem.downloadUrl ?? undefined}
          circleId={displayItem.circleId}
        />

        {/* Tags */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Tags
        </Typography>

        {/* AI tagging status + rerun */}
        {(() => {
          const chipProps = tagStatusChipProps(tagStatus?.status);
          return (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, mb: 1 }}>
              <Chip
                label={chipProps.label}
                color={chipProps.color}
                size="small"
                icon={<LocalOfferIcon />}
              />
              {tagStatus?.providerKey && (
                <Typography variant="caption" color="text.secondary">
                  {tagStatus.providerKey}
                </Typography>
              )}
              <Button
                size="small"
                variant="outlined"
                startIcon={rerunTagsLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
                onClick={() => void rerunTags()}
                disabled={rerunTagsLoading}
                sx={{ minHeight: 44 }}
              >
                Re-run AI tagging
              </Button>
            </Stack>
          );
        })()}

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
          <Button size="small" variant="outlined" onClick={() => setTagEditOpen(true)} sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}>
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
                sx={{ minHeight: 44 }}
              >
                Cancel
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => void handleSaveTags()}
                disabled={(editTagsAdd.length === 0 && editTagsRemove.length === 0) || tagSaving}
                startIcon={tagSaving ? <CircularProgress size={12} /> : undefined}
                sx={{ minHeight: 44 }}
              >
                Save Tags
              </Button>
            </Stack>
          </Stack>
        )}

        {/* Metadata extraction */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Metadata
        </Typography>
        {(() => {
          const chipProps = metadataStatusChipProps(metadataStatus?.status);
          return (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, mb: 1 }}>
              <Chip
                label={chipProps.label}
                color={chipProps.color}
                size="small"
                icon={<InfoOutlinedIcon />}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={rerunMetadataLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
                onClick={() => void rerunMetadata()}
                disabled={rerunMetadataLoading}
                sx={{ minHeight: 44 }}
              >
                Re-run metadata extraction
              </Button>
            </Stack>
          );
        })()}
        {metadataStatus?.status === 'failed' && metadataStatus.lastError && (
          <Alert severity="error" sx={{ mb: 1 }}>{metadataStatus.lastError}</Alert>
        )}

        {/* Timestamps */}
        <Divider sx={{ my: 1.5 }} />
        <MetaRow label="Created" value={formatDateTime(item.createdAt)} />
        <MetaRow label="Updated" value={formatDateTime(item.updatedAt)} />
        {item.archivedAt && (
          <MetaRow label="Archived" value={formatDateTime(item.archivedAt)} />
        )}

        {/* Archive / Delete actions */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Actions
        </Typography>

        {archiveError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setArchiveError(null)}>
            {archiveError}
          </Alert>
        )}
        {deleteError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setDeleteError(null)}>
            {deleteError}
          </Alert>
        )}

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={
              archiveLoading
                ? <CircularProgress size={14} />
                : displayItem.archivedAt !== null
                  ? <UnarchiveIcon />
                  : <ArchiveIcon />
            }
            onClick={() => void handleToggleArchive()}
            disabled={archiveLoading}
            sx={{ minHeight: 44 }}
          >
            {displayItem.archivedAt !== null ? 'Unarchive' : 'Archive'}
          </Button>

          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={deleteLoading ? <CircularProgress size={14} /> : <DeleteIcon />}
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteLoading}
            sx={{ minHeight: 44 }}
          >
            Move to Trash
          </Button>
        </Stack>
      </Box>

      {/* Move to Trash confirm dialog */}
      <Dialog open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Move to Trash?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This item will be moved to Trash and can be recovered within the retention period.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)} disabled={deleteLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleDelete()}
            color="error"
            variant="contained"
            disabled={deleteLoading}
          >
            Move to Trash
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
