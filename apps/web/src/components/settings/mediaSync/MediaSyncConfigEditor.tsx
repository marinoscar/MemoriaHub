/**
 * The desired Media Sync configuration of one phone (issue #515, spec §5).
 *
 * A form over `device.config`: target circle, folders (from the phone's
 * reported inventory), photos/videos, network policy, charging and
 * "upload existing". Save sends `PATCH /api/media-sync/devices/:id/config`
 * with ONLY the fields that changed. `paused` and the two generations are
 * commands, never part of this form.
 *
 * The phone applies the result the next time it checks in; the server keeps
 * the newest write. While the user edits, the 30 s background refetch must
 * not clobber the draft, so the draft is re-seeded from the server only when
 * it is clean (or after a successful save).
 *
 * 400 `UNKNOWN_FOLDER` (`details.bucketIds`) and 403 `TARGET_CIRCLE_FORBIDDEN`
 * are shown on their own field.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  InputLabel,
  List,
  ListItem,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  mediaSyncErrorMessage,
  mediaSyncErrorReason,
  unknownFolderIds,
  updateDeviceConfig,
  type MediaSyncConfig,
  type MediaSyncConfigPatch,
  type MediaSyncConfigResult,
  type MediaSyncDevice,
  type MediaSyncFolder,
  type MediaSyncNetworkPolicy,
  type MediaSyncUploadExisting,
} from '../../../services/mediaSync';
import { formatBytes } from '../../../utils/formatBytes';
import { useIsMounted } from '../../../hooks/useIsMounted';

export const NO_INVENTORY_MESSAGE = 'Open the app on your phone once so it can report its folders.';
export const DATA_USAGE_NOTE =
  'Wi-Fi and mobile data uploads over your mobile plan too, which can use a lot of data for videos.';

/** A circle the user may sync into (collaborator or admin there). */
export interface TargetCircleOption {
  id: string;
  name: string;
}

interface Draft {
  targetCircleId: string;
  /** Selected bucket ids, in a stable order. */
  folderIds: string[];
  includePhotos: boolean;
  includeVideos: boolean;
  network: MediaSyncNetworkPolicy;
  requireCharging: boolean;
  uploadExisting: MediaSyncUploadExisting;
}

function draftFromConfig(config: MediaSyncConfig): Draft {
  return {
    targetCircleId: config.targetCircleId,
    folderIds: config.folders.map((f) => f.bucketId),
    includePhotos: config.includePhotos,
    includeVideos: config.includeVideos,
    network: config.network,
    requireCharging: config.requireCharging,
    uploadExisting: config.uploadExisting,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

/**
 * The PATCH body: only what changed. Exported for tests. Folder names come
 * from the inventory (the server overwrites them from it anyway), falling
 * back to the stored name for a folder the phone no longer reports.
 */
export function buildConfigPatch(
  config: MediaSyncConfig,
  draft: Draft,
  inventory: MediaSyncDevice['inventory'],
): MediaSyncConfigPatch {
  const patch: MediaSyncConfigPatch = {};
  if (draft.targetCircleId !== config.targetCircleId) patch.targetCircleId = draft.targetCircleId;
  if (!sameSet(draft.folderIds, config.folders.map((f) => f.bucketId))) {
    const names = new Map<string, string>();
    for (const f of config.folders) names.set(f.bucketId, f.name);
    for (const f of inventory ?? []) names.set(f.bucketId, f.name);
    patch.folders = draft.folderIds.map(
      (bucketId): MediaSyncFolder => ({ bucketId, name: names.get(bucketId) ?? bucketId }),
    );
  }
  if (draft.includePhotos !== config.includePhotos) patch.includePhotos = draft.includePhotos;
  if (draft.includeVideos !== config.includeVideos) patch.includeVideos = draft.includeVideos;
  if (draft.network !== config.network) patch.network = draft.network;
  if (draft.requireCharging !== config.requireCharging) patch.requireCharging = draft.requireCharging;
  if (draft.uploadExisting !== config.uploadExisting) patch.uploadExisting = draft.uploadExisting;
  return patch;
}

interface MediaSyncConfigEditorProps {
  device: MediaSyncDevice;
  circles: TargetCircleOption[];
  canWrite: boolean;
  onSaved: (result: MediaSyncConfigResult) => void;
}

export function MediaSyncConfigEditor({ device, circles, canWrite, onSaved }: MediaSyncConfigEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(device.config));
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [circleError, setCircleError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isMounted = useIsMounted();

  const patch = useMemo(
    () => buildConfigPatch(device.config, draft, device.inventory),
    [device.config, draft, device.inventory],
  );
  const dirty = Object.keys(patch).length > 0;

  // Re-seed from the server whenever it changed and the user has no edits.
  useEffect(() => {
    if (!dirty) setDraft(draftFromConfig(device.config));
    // Only when the server version moves; `dirty` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.configVersion]);

  const readOnly = !canWrite || device.status !== 'active';
  const inventory = device.inventory ?? [];
  const inventoryIds = new Set(inventory.map((f) => f.bucketId));
  // Folders the config selects but the phone no longer reports.
  const missing = device.config.folders.filter((f) => !inventoryIds.has(f.bucketId));
  const query = search.trim().toLowerCase();
  const visible = inventory.filter(
    (f) =>
      !query ||
      f.name.toLowerCase().includes(query) ||
      (f.relativePath ?? '').toLowerCase().includes(query),
  );
  const circleOptions = circles.some((c) => c.id === draft.targetCircleId)
    ? circles
    : [...circles, { id: draft.targetCircleId, name: 'Current circle (not editable by you)' }];

  const update = (next: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...next }));
  };
  const toggleFolder = (bucketId: string, checked: boolean) => {
    setFolderError(null);
    update({
      folderIds: checked
        ? [...draft.folderIds.filter((id) => id !== bucketId), bucketId]
        : draft.folderIds.filter((id) => id !== bucketId),
    });
  };
  const selectVisible = (checked: boolean) => {
    setFolderError(null);
    const ids = visible.map((f) => f.bucketId);
    update({
      folderIds: checked
        ? Array.from(new Set([...draft.folderIds, ...ids]))
        : draft.folderIds.filter((id) => !ids.includes(id)),
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setFolderError(null);
    setCircleError(null);
    setSaved(false);
    try {
      const result = await updateDeviceConfig(device.id, patch);
      if (!isMounted()) return;
      setDraft(draftFromConfig(result.config));
      setSaved(true);
      onSaved(result);
    } catch (err) {
      if (!isMounted()) return;
      const reason = mediaSyncErrorReason(err);
      if (reason === 'UNKNOWN_FOLDER') {
        const ids = unknownFolderIds(err);
        const names = ids.map(
          (id) => device.config.folders.find((f) => f.bucketId === id)?.name ?? id,
        );
        setFolderError(
          `The phone no longer reports ${names.length === 1 ? 'this folder' : 'these folders'}: ${names.join(', ')}. Unselect ${names.length === 1 ? 'it' : 'them'} and save again.`,
        );
      } else if (reason === 'TARGET_CIRCLE_FORBIDDEN') {
        setCircleError('You can only sync into a circle where you are a collaborator or admin.');
      } else {
        setError(mediaSyncErrorMessage(err, 'Failed to save the sync settings'));
      }
    } finally {
      if (isMounted()) setSaving(false);
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((f) => draft.folderIds.includes(f.bucketId));

  return (
    <Stack spacing={3} component="form" aria-label={`Sync settings for ${device.name}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <FormControl fullWidth error={!!circleError} disabled={readOnly}>
        <InputLabel id={`target-circle-${device.id}`}>Upload into circle</InputLabel>
        <Select
          labelId={`target-circle-${device.id}`}
          label="Upload into circle"
          value={draft.targetCircleId}
          onChange={(e) => {
            setCircleError(null);
            update({ targetCircleId: String(e.target.value) });
          }}
        >
          {circleOptions.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>{circleError ?? 'New photos and videos from this phone go into this circle.'}</FormHelperText>
      </FormControl>

      <FormControl component="fieldset" error={!!folderError} disabled={readOnly} sx={{ minWidth: 0 }}>
        <FormLabel component="legend">Folders</FormLabel>
        {inventory.length === 0 ? (
          <Typography variant="body2" color="text.secondary" data-testid="no-inventory">
            {NO_INVENTORY_MESSAGE}
          </Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', my: 1 }}>
              <TextField
                size="small"
                label="Search folders"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                sx={{ flex: '1 1 180px', minWidth: 0 }}
              />
              <Button size="small" onClick={() => selectVisible(true)} disabled={readOnly || allVisibleSelected}>
                Select all
              </Button>
              <Button size="small" onClick={() => selectVisible(false)} disabled={readOnly || draft.folderIds.length === 0}>
                None
              </Button>
            </Box>
            <List dense disablePadding sx={{ maxHeight: 320, overflowY: 'auto' }} aria-label="Phone folders">
              {visible.map((f) => (
                <ListItem key={f.bucketId} disableGutters>
                  <FormControlLabel
                    sx={{ mr: 0, minWidth: 0, alignItems: 'flex-start' }}
                    control={
                      <Checkbox
                        checked={draft.folderIds.includes(f.bucketId)}
                        onChange={(e) => toggleFolder(f.bucketId, e.target.checked)}
                        sx={{ pt: 0.5 }}
                      />
                    }
                    label={
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                          {f.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {f.photoCount} photo{f.photoCount === 1 ? '' : 's'} · {f.videoCount} video
                          {f.videoCount === 1 ? '' : 's'} · {formatBytes(String(Math.max(0, Math.trunc(f.bytes))))}
                          {f.relativePath ? ` · ${f.relativePath}` : ''}
                        </Typography>
                      </Box>
                    }
                  />
                </ListItem>
              ))}
              {visible.length === 0 && (
                <ListItem disableGutters>
                  <Typography variant="body2" color="text.secondary">
                    No folder matches “{search}”.
                  </Typography>
                </ListItem>
              )}
            </List>
          </>
        )}
        {missing.length > 0 && (
          <Box sx={{ mt: 1 }} data-testid="missing-folders">
            {missing.map((f) => (
              <FormControlLabel
                key={f.bucketId}
                control={
                  <Checkbox
                    checked={draft.folderIds.includes(f.bucketId)}
                    onChange={(e) => toggleFolder(f.bucketId, e.target.checked)}
                  />
                }
                label={`${f.name} (no longer on the phone)`}
              />
            ))}
          </Box>
        )}
        <FormHelperText>
          {folderError ??
            `${draft.folderIds.length} folder${draft.folderIds.length === 1 ? '' : 's'} selected. Nothing syncs until you select at least one.`}
        </FormHelperText>
      </FormControl>

      <FormControl component="fieldset" disabled={readOnly}>
        <FormLabel component="legend">What to sync</FormLabel>
        <FormControlLabel
          control={<Switch checked={draft.includePhotos} onChange={(e) => update({ includePhotos: e.target.checked })} />}
          label="Include photos"
        />
        <FormControlLabel
          control={<Switch checked={draft.includeVideos} onChange={(e) => update({ includeVideos: e.target.checked })} />}
          label="Include videos"
        />
      </FormControl>

      <FormControl component="fieldset" disabled={readOnly}>
        <FormLabel component="legend" id={`network-${device.id}`}>
          Network
        </FormLabel>
        <RadioGroup
          aria-labelledby={`network-${device.id}`}
          value={draft.network}
          onChange={(e) => update({ network: e.target.value as MediaSyncNetworkPolicy })}
        >
          <FormControlLabel value="wifi" control={<Radio />} label="Wi-Fi only" />
          <FormControlLabel value="any" control={<Radio />} label="Wi-Fi and mobile data" />
        </RadioGroup>
        <FormHelperText>{DATA_USAGE_NOTE}</FormHelperText>
        <FormControlLabel
          control={
            <Switch checked={draft.requireCharging} onChange={(e) => update({ requireCharging: e.target.checked })} />
          }
          label="Only while charging"
        />
      </FormControl>

      <FormControl component="fieldset" disabled={readOnly}>
        <FormLabel component="legend" id={`existing-${device.id}`}>
          Upload existing
        </FormLabel>
        <RadioGroup
          aria-labelledby={`existing-${device.id}`}
          value={draft.uploadExisting}
          onChange={(e) => update({ uploadExisting: e.target.value as MediaSyncUploadExisting })}
        >
          <FormControlLabel value="all" control={<Radio />} label="All in selected folders" />
          <FormControlLabel value="from_pairing" control={<Radio />} label="Only new from now on" />
        </RadioGroup>
      </FormControl>

      {error && <Alert severity="error">{error}</Alert>}
      {saved && !dirty && (
        <Alert severity="success" onClose={() => setSaved(false)}>
          Saved. The phone applies it the next time it checks in.
        </Alert>
      )}

      {!readOnly && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            type="submit"
            variant="contained"
            disabled={!dirty || saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ minHeight: 44 }}
          >
            Save
          </Button>
          <Button
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(draftFromConfig(device.config));
              setFolderError(null);
              setCircleError(null);
              setError(null);
            }}
            sx={{ minHeight: 44 }}
          >
            Discard changes
          </Button>
        </Box>
      )}
    </Stack>
  );
}
