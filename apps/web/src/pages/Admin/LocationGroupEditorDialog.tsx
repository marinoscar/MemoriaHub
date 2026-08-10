/**
 * LocationGroupEditorDialog — create/edit one location group (issue #375).
 *
 * Split out of `LocationGroupsSettingsPage` for the same reason
 * `DbBackupRestoreDialog` is split out of `DbBackupPage`: the dialog carries a
 * lot of its own state (member picker, cover picker, area map) that the page
 * itself never reads.
 *
 * Two modes, one component:
 *   - `create` — nothing exists server-side yet, so member additions and the
 *     cover choice are accumulated LOCALLY and submitted in a single POST.
 *   - `edit`   — the group exists, so a member add/remove is an immediate call
 *     to `POST`/`DELETE /location-groups/:id/members`. That is what makes the
 *     `409` legible in real time: the conflicting value is rejected the moment
 *     it is picked, naming the group that already owns it.
 *
 * ⚠️ The `409` owner is read from `details.groupName` (see
 * `extractLocationGroupConflict`), never a top-level field.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  ListItem,
  ListItemText,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { LocationPickerMap } from '../../components/media/LocationPickerMap';
import { useCircleContext } from '../../contexts/CircleContext';
import { listMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';
import {
  addLocationGroupMembers,
  createLocationGroup,
  getLocationGroup,
  listLocationValues,
  locationGroupErrorMessage,
  removeLocationGroupMembers,
  updateLocationGroup,
} from '../../services/locationGroups';
import type {
  LocationGroupDetail,
  LocationGroupLevel,
  LocationValue,
} from '../../services/locationGroups';

export interface LocationGroupEditorDialogProps {
  open: boolean;
  /** `null` = create a new group at `level`; otherwise edit this group. */
  groupId: string | null;
  level: LocationGroupLevel;
  /** Ceiling for the radius slider — the LOADED `locationGrouping.maxRadiusKm`. */
  maxRadiusKm: number;
  onClose: () => void;
  onSaved: () => void;
}

const LEVEL_LABEL: Record<LocationGroupLevel, string> = {
  country: 'Country',
  region: 'Region',
  locality: 'City',
};

/** Which `GET /api/media` filter selects a group's own photos, per level. */
const LEVEL_MEDIA_FILTER: Record<LocationGroupLevel, 'country' | 'region' | 'locality'> = {
  country: 'country',
  region: 'region',
  locality: 'locality',
};

export default function LocationGroupEditorDialog({
  open,
  groupId,
  level,
  maxRadiusKm,
  onClose,
  onSaved,
}: LocationGroupEditorDialogProps) {
  const isEdit = groupId !== null;
  const { activeCircleId } = useCircleContext();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const [canonicalName, setCanonicalName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [coverMediaItemId, setCoverMediaItemId] = useState<string | null>(null);

  const [areaEnabled, setAreaEnabled] = useState(false);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(5);

  // Member picker
  const [valueQuery, setValueQuery] = useState('');
  const [valueOptions, setValueOptions] = useState<LocationValue[]>([]);
  const [valuesLoading, setValuesLoading] = useState(false);

  // Cover picker
  const [coverCandidates, setCoverCandidates] = useState<MediaItem[]>([]);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  const resetForm = useCallback(() => {
    setCanonicalName('');
    setCountryCode('');
    setMembers([]);
    setCoverMediaItemId(null);
    setAreaEnabled(false);
    setCenter(null);
    setRadiusKm(Math.min(5, maxRadiusKm));
    setError(null);
    setMemberError(null);
    setValueQuery('');
    setValueOptions([]);
    setCoverCandidates([]);
  }, [maxRadiusKm]);

  const applyDetail = useCallback((detail: LocationGroupDetail) => {
    setCanonicalName(detail.canonicalName);
    setCountryCode(detail.countryCode);
    setMembers(detail.aliases.map((a) => a.rawValue));
    setCoverMediaItemId(detail.coverMediaItemId);
    const hasArea = detail.centerLat !== null && detail.centerLng !== null && detail.radiusKm !== null;
    setAreaEnabled(hasArea);
    setCenter(hasArea ? { lat: detail.centerLat as number, lng: detail.centerLng as number } : null);
    if (detail.radiusKm !== null) setRadiusKm(detail.radiusKm);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetForm();
    if (!groupId) return;

    let cancelled = false;
    setLoading(true);
    getLocationGroup(groupId)
      .then((detail) => {
        if (!cancelled) applyDetail(detail);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(locationGroupErrorMessage(err, 'Failed to load the group'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, groupId, resetForm, applyDetail]);

  // Member-picker options. Fetched on open and whenever the query changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setValuesLoading(true);
    listLocationValues({ level, q: valueQuery || undefined, grouped: 'all', limit: 50 })
      .then((res) => {
        if (!cancelled) setValueOptions(res.items);
      })
      .catch(() => {
        if (!cancelled) setValueOptions([]);
      })
      .finally(() => {
        if (!cancelled) setValuesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, level, valueQuery]);

  // Cover candidates — the group's OWN photos, in the active circle.
  useEffect(() => {
    if (!open || !activeCircleId || !canonicalName.trim()) {
      return;
    }
    let cancelled = false;
    listMedia({
      circleId: activeCircleId,
      [LEVEL_MEDIA_FILTER[level]]: canonicalName.trim(),
      pageSize: 12,
    })
      .then((res) => {
        if (!cancelled) setCoverCandidates(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setCoverCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeCircleId, level, canonicalName]);

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  const handleAddMember = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setMemberError(null);

      if (members.some((m) => m.toLowerCase() === trimmed.toLowerCase())) return;

      if (!isEdit || !groupId) {
        setMembers((prev) => [...prev, trimmed]);
        return;
      }

      try {
        await addLocationGroupMembers(groupId, [trimmed]);
        setMembers((prev) => [...prev, trimmed]);
      } catch (err: unknown) {
        // Surfaces `details.groupName` — "Already in group \"Heredia\" — …".
        setMemberError(locationGroupErrorMessage(err, 'Failed to add the member value'));
      }
    },
    [members, isEdit, groupId],
  );

  const handleRemoveMember = useCallback(
    async (value: string) => {
      setMemberError(null);
      if (!isEdit || !groupId) {
        setMembers((prev) => prev.filter((m) => m !== value));
        return;
      }
      try {
        await removeLocationGroupMembers(groupId, [value]);
        setMembers((prev) => prev.filter((m) => m !== value));
      } catch (err: unknown) {
        setMemberError(locationGroupErrorMessage(err, 'Failed to remove the member value'));
      }
    },
    [isEdit, groupId],
  );

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  const geometry = useMemo(() => {
    if (areaEnabled && center) {
      return { center, radiusKm: Math.min(radiusKm, maxRadiusKm) };
    }
    return { center: null, radiusKm: null };
  }, [areaEnabled, center, radiusKm, maxRadiusKm]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (isEdit && groupId) {
        await updateLocationGroup(groupId, {
          canonicalName: canonicalName.trim(),
          coverMediaItemId,
          center: geometry.center,
          radiusKm: geometry.radiusKm,
        });
      } else {
        await createLocationGroup({
          level,
          canonicalName: canonicalName.trim(),
          countryCode: countryCode.trim(),
          memberValues: members,
          coverMediaItemId: coverMediaItemId ?? undefined,
          center: geometry.center,
          radiusKm: geometry.radiusKm,
        });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(locationGroupErrorMessage(err, 'Failed to save the group'));
    } finally {
      setSaving(false);
    }
  }, [
    isEdit,
    groupId,
    canonicalName,
    countryCode,
    members,
    coverMediaItemId,
    geometry,
    level,
    onSaved,
    onClose,
  ]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {isEdit ? 'Edit location group' : `New ${LEVEL_LABEL[level].toLowerCase()} group`}
      </DialogTitle>
      <DialogContent dividers sx={{ overflowX: 'hidden' }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Stack spacing={3} sx={{ minWidth: 0 }}>
            {error && (
              <Alert severity="error" onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Canonical name"
                value={canonicalName}
                onChange={(e) => setCanonicalName(e.target.value)}
                fullWidth
                size="small"
                helperText="The display name every member value collapses into."
              />
              <TextField
                label="Country scope"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                size="small"
                disabled={isEdit}
                sx={{ width: { xs: '100%', sm: 200 } }}
                helperText={isEdit ? 'Fixed after creation' : 'ISO code; blank = unscoped'}
              />
            </Stack>

            <Divider />

            {/* --------------------------------------------------------- */}
            {/* Members                                                    */}
            {/* --------------------------------------------------------- */}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Member values
              </Typography>

              {memberError && (
                <Alert severity="warning" sx={{ mb: 1 }} onClose={() => setMemberError(null)}>
                  {memberError}
                </Alert>
              )}

              <Autocomplete
                options={valueOptions}
                loading={valuesLoading}
                getOptionLabel={(option) => option.value}
                isOptionEqualToValue={(a, b) => a.value === b.value}
                filterOptions={(options) => options}
                inputValue={valueQuery}
                onInputChange={(_, next) => setValueQuery(next)}
                value={null}
                onChange={(_, option) => {
                  if (option) void handleAddMember(option.value);
                }}
                renderOption={(props, option) => {
                  const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
                  return (
                    <ListItem key={key ?? option.value} {...(rest as object)} dense>
                      <ListItemText
                        primary={option.value}
                        secondary={
                          option.groupCanonicalName
                            ? `${option.itemCount} photos · in group "${option.groupCanonicalName}"`
                            : `${option.itemCount} photos · ungrouped`
                        }
                      />
                    </ListItem>
                  );
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    label="Add a raw location value"
                    placeholder="Search raw geocoder values…"
                  />
                )}
              />

              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
                {members.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    No member values yet.
                  </Typography>
                ) : (
                  members.map((member) => (
                    <Chip
                      key={member}
                      label={member}
                      size="small"
                      onDelete={() => void handleRemoveMember(member)}
                    />
                  ))
                )}
              </Box>
            </Box>

            <Divider />

            {/* --------------------------------------------------------- */}
            {/* Cover                                                      */}
            {/* --------------------------------------------------------- */}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Cover photo
              </Typography>
              {coverCandidates.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  No photos from this group are available in the active circle yet.
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {coverCandidates.map((item) => (
                    <Avatar
                      key={item.id}
                      src={item.thumbnailUrl ?? undefined}
                      variant="rounded"
                      alt={item.originalFilename}
                      onClick={() =>
                        setCoverMediaItemId((prev) => (prev === item.id ? null : item.id))
                      }
                      data-testid={`cover-candidate-${item.id}`}
                      sx={{
                        width: 56,
                        height: 56,
                        cursor: 'pointer',
                        border: (theme) =>
                          coverMediaItemId === item.id
                            ? `2px solid ${theme.palette.primary.main}`
                            : '2px solid transparent',
                      }}
                    />
                  ))}
                </Box>
              )}
            </Box>

            <Divider />

            {/* --------------------------------------------------------- */}
            {/* Area                                                       */}
            {/* --------------------------------------------------------- */}
            <Box sx={{ minWidth: 0 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={areaEnabled}
                    onChange={(e) => setAreaEnabled(e.target.checked)}
                  />
                }
                label="Define a capture area"
                sx={{ display: 'block' }}
              />
              <Typography variant="caption" color="text.secondary">
                Photos taken within this radius of the centre are captured by the group even when
                their raw geocoder value is not a listed member.
              </Typography>

              {areaEnabled && (
                <Box sx={{ mt: 2, minWidth: 0 }}>
                  <LocationPickerMap
                    value={center}
                    onChange={setCenter}
                    height={240}
                    initialCenter={center ?? undefined}
                    geolocateSetsValue={false}
                    scrollWheelZoom={false}
                    radiusMeters={center ? Math.min(radiusKm, maxRadiusKm) * 1000 : null}
                  />
                  <Typography gutterBottom sx={{ mt: 2 }}>
                    Radius: <strong>{radiusKm.toFixed(1)} km</strong>
                  </Typography>
                  <Slider
                    value={Math.min(radiusKm, maxRadiusKm)}
                    onChange={(_, v) => setRadiusKm(v as number)}
                    min={0.5}
                    max={maxRadiusKm}
                    step={0.5}
                    valueLabelDisplay="auto"
                    aria-label="Capture radius in kilometres"
                  />
                  <Typography variant="caption" color="text.secondary">
                    Capped by the global maximum capture radius ({maxRadiusKm} km).
                  </Typography>
                </Box>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving || loading || !canonicalName.trim()}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          {isEdit ? 'Save group' : 'Create group'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
