/**
 * LocationGroupsSettingsPage — Admin > Location Groups (issue #375).
 *
 * Structure deliberately mirrors `LocationInferenceSettingsPage`: an inner
 * `…Content()` component wrapped by a `usePermissions()` guard, a
 * `<Container maxWidth="lg">`, a "Back to Settings" link, an icon + `h4`
 * heading, then sequential `<Paper variant="outlined">` sections and a pair of
 * feedback `<Snackbar>`s.
 *
 * RBAC: `geo_settings:read` (Admin). Location groups are a global geo
 * configuration exactly like the active reverse-geocoding provider, so the
 * backend reuses the `geo_settings:*` pair rather than minting a permission —
 * and so does this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  IconButton,
  Link,
  Paper,
  Slider,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Edit as EditIcon,
  Add as AddIcon,
  Refresh as RefreshIcon,
  Public as PublicIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { listJobs } from '../../services/jobs';
import {
  LOCATION_GROUP_REBUILD_JOB_TYPE,
  createLocationGroup,
  deleteLocationGroup,
  listLocationGroupSuggestions,
  listLocationGroups,
  locationGroupErrorMessage,
  rebuildLocationGroups,
  updateLocationGroup,
} from '../../services/locationGroups';
import type {
  LocationGroupLevel,
  LocationGroupSuggestion,
  LocationGroupSummary,
} from '../../services/locationGroups';
import LocationGroupEditorDialog from './LocationGroupEditorDialog';

const LEVEL_TABS: Array<{ level: LocationGroupLevel; label: string }> = [
  { level: 'country', label: 'Countries' },
  { level: 'region', label: 'Regions' },
  { level: 'locality', label: 'Cities' },
];

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed']);
const REBUILD_POLL_MS = 3000;

function LocationGroupsSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // ---- Global settings (one Save for the whole namespace) ------------------
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [radiusCaptureEnabled, setRadiusCaptureEnabled] = useState(true);
  const [maxRadiusKm, setMaxRadiusKm] = useState(50);
  const [suggestionMinItems, setSuggestionMinItems] = useState(1);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // ---- Level tab ----------------------------------------------------------
  const [level, setLevel] = useState<LocationGroupLevel>('locality');

  // ---- Suggestions --------------------------------------------------------
  const [suggestions, setSuggestions] = useState<LocationGroupSuggestion[]>([]);
  const [suggestionNames, setSuggestionNames] = useState<Record<string, string>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [mergingKey, setMergingKey] = useState<string | null>(null);

  // ---- Groups -------------------------------------------------------------
  const [groups, setGroups] = useState<LocationGroupSummary[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [search, setSearch] = useState('');

  // ---- Editor dialog ------------------------------------------------------
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorGroupId, setEditorGroupId] = useState<string | null>(null);

  // ---- Rebuild ------------------------------------------------------------
  const [rebuildJobId, setRebuildJobId] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] = useState<string | null>(null);
  const [rebuildLoading, setRebuildLoading] = useState(false);

  // ---- Feedback -----------------------------------------------------------
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Sync form fields from settings
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!settings) return;
    setFeatureEnabled(settings.features?.locationGrouping ?? false);
    setRadiusCaptureEnabled(settings.locationGrouping?.radiusCaptureEnabled ?? true);
    setMaxRadiusKm(settings.locationGrouping?.maxRadiusKm ?? 50);
    setSuggestionMinItems(settings.locationGrouping?.suggestionMinItems ?? 1);
  }, [settings]);

  /**
   * The radius slider's ceiling comes from the LOADED setting, never a
   * hard-coded constant — the API rejects a `radiusKm` above it with a 400.
   */
  const effectiveMaxRadiusKm = settings?.locationGrouping?.maxRadiusKm ?? maxRadiusKm;

  const handleSaveSettings = useCallback(() => {
    setSettingsSaving(true);
    updateSettings({
      features: { ...(settings?.features ?? {}), locationGrouping: featureEnabled },
      locationGrouping: { radiusCaptureEnabled, maxRadiusKm, suggestionMinItems },
    })
      .then(() => setSuccessMessage('Location grouping settings saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      })
      .finally(() => setSettingsSaving(false));
  }, [
    updateSettings,
    settings,
    featureEnabled,
    radiusCaptureEnabled,
    maxRadiusKm,
    suggestionMinItems,
  ]);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadGroups = useCallback(() => {
    setGroupsLoading(true);
    listLocationGroups({ level, q: search || undefined, page: 1, pageSize: 100 })
      .then((res) => {
        if (mountedRef.current) setGroups(res.items);
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to load location groups'));
        }
      })
      .finally(() => {
        if (mountedRef.current) setGroupsLoading(false);
      });
  }, [level, search]);

  const loadSuggestions = useCallback(() => {
    setSuggestionsLoading(true);
    listLocationGroupSuggestions({ level, limit: 25 })
      .then((res) => {
        if (!mountedRef.current) return;
        setSuggestions(res.items);
        setSuggestionNames(
          Object.fromEntries(
            res.items.map((s) => [suggestionKeyOf(s), s.suggestedCanonicalName]),
          ),
        );
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to load suggestions'));
        }
      })
      .finally(() => {
        if (mountedRef.current) setSuggestionsLoading(false);
      });
  }, [level]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  // -------------------------------------------------------------------------
  // Suggestions → merge
  // -------------------------------------------------------------------------

  const handleMerge = useCallback(
    async (suggestion: LocationGroupSuggestion) => {
      const key = suggestionKeyOf(suggestion);
      setMergingKey(key);
      setLocalError(null);
      try {
        await createLocationGroup({
          level,
          canonicalName: (suggestionNames[key] ?? suggestion.suggestedCanonicalName).trim(),
          countryCode: suggestion.countryCode ?? '',
          memberValues: suggestion.members.map((m) => m.value),
        });
        if (!mountedRef.current) return;
        setSuggestions((prev) => prev.filter((s) => suggestionKeyOf(s) !== key));
        setSuccessMessage('Location group created');
        loadGroups();
      } catch (err: unknown) {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to create the group'));
        }
      } finally {
        if (mountedRef.current) setMergingKey(null);
      }
    },
    [level, suggestionNames, loadGroups],
  );

  // -------------------------------------------------------------------------
  // Groups → toggle / delete
  // -------------------------------------------------------------------------

  const handleToggleGroup = useCallback(
    async (group: LocationGroupSummary, enabled: boolean) => {
      setLocalError(null);
      try {
        await updateLocationGroup(group.id, { enabled });
        if (!mountedRef.current) return;
        setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, enabled } : g)));
      } catch (err: unknown) {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to update the group'));
        }
      }
    },
    [],
  );

  const handleDeleteGroup = useCallback(
    async (group: LocationGroupSummary) => {
      setLocalError(null);
      try {
        await deleteLocationGroup(group.id);
        if (!mountedRef.current) return;
        setGroups((prev) => prev.filter((g) => g.id !== group.id));
        setSuccessMessage(`Deleted "${group.canonicalName}"`);
      } catch (err: unknown) {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to delete the group'));
        }
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Rebuild + job polling
  // -------------------------------------------------------------------------

  const handleRebuild = useCallback(() => {
    setRebuildLoading(true);
    setLocalError(null);
    rebuildLocationGroups()
      .then((res) => {
        if (!mountedRef.current) return;
        setRebuildJobId(res.jobId);
        setRebuildStatus(res.status);
        setSuccessMessage('Rebuild queued');
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setLocalError(locationGroupErrorMessage(err, 'Failed to queue the rebuild'));
        }
      })
      .finally(() => {
        if (mountedRef.current) setRebuildLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!rebuildJobId) return;
    if (rebuildStatus && TERMINAL_JOB_STATUSES.has(rebuildStatus)) return;

    const timer = setInterval(() => {
      listJobs({ type: LOCATION_GROUP_REBUILD_JOB_TYPE, pageSize: 20 })
        .then((res) => {
          if (!mountedRef.current) return;
          const job = res.items.find((j) => j.id === rebuildJobId);
          if (job) setRebuildStatus(job.status);
        })
        .catch(() => {
          /* transient poll failure is not worth surfacing */
        });
    }, REBUILD_POLL_MS);

    return () => clearInterval(timer);
  }, [rebuildJobId, rebuildStatus]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const visibleSuggestions = useMemo(() => suggestions, [suggestions]);

  if (!settings && !error) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !settings) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        {error}
      </Alert>
    );
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4, minWidth: 0 }}>
        {/* Back link */}
        <Link
          component={RouterLink}
          to="/admin/settings"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Settings
        </Link>

        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <PublicIcon color="primary" />
          <Typography variant="h4" component="h1">
            Location Groups
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Collapse the many spellings a geocoder returns for one place — "Heredia", "Heredia
          Province", "Provincia de Heredia" — into a single canonical name used everywhere photos
          are browsed.
        </Typography>

        {/* ---------------------------------------------------------------- */}
        {/* Section 1: Global Settings                                        */}
        {/* ---------------------------------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={featureEnabled}
                onChange={(e) => setFeatureEnabled(e.target.checked)}
                disabled={!settings}
              />
            }
            label="Enable location grouping globally"
            sx={{ display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            When off, browse surfaces fall back to the raw geocoder names and nothing is rewritten.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={radiusCaptureEnabled}
                onChange={(e) => setRadiusCaptureEnabled(e.target.checked)}
                disabled={!settings}
              />
            }
            label="Capture photos by area radius"
            sx={{ display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Lets a group claim photos whose coordinates fall inside its configured circle, even when
            the raw geocoder value is not a listed member.
          </Typography>

          <Box sx={{ mb: 3 }}>
            <Typography gutterBottom>
              Maximum capture radius: <strong>{maxRadiusKm} km</strong>
            </Typography>
            <Slider
              value={maxRadiusKm}
              onChange={(_, v) => setMaxRadiusKm(v as number)}
              min={0.5}
              max={200}
              step={0.5}
              valueLabelDisplay="auto"
              aria-label="Maximum capture radius"
            />
            <Typography variant="caption" color="text.secondary">
              Ceiling (0.5–200 km) for any single group's area. A group asking for more is rejected
              rather than silently clamped.
            </Typography>
          </Box>

          <TextField
            label="Minimum photos per suggested value"
            type="number"
            size="small"
            value={suggestionMinItems}
            onChange={(e) =>
              setSuggestionMinItems(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))
            }
            slotProps={{ htmlInput: { min: 1, max: 1000 } }}
            helperText="Raw values below this photo count never appear as a grouping suggestion."
            sx={{ mb: 2, width: { xs: '100%', sm: 320 } }}
          />

          <Box>
            <Button
              variant="contained"
              disabled={isSaving || settingsSaving || !settings}
              startIcon={settingsSaving ? <CircularProgress size={16} /> : undefined}
              onClick={handleSaveSettings}
            >
              Save Settings
            </Button>
          </Box>
        </Paper>

        {/* Level tabs shared by the Suggestions and Groups sections */}
        <Paper variant="outlined" sx={{ p: 1, mb: 2 }}>
          <Tabs
            value={level}
            onChange={(_, next: LocationGroupLevel) => setLevel(next)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
          >
            {LEVEL_TABS.map((tab) => (
              <Tab key={tab.level} value={tab.level} label={tab.label} />
            ))}
          </Tabs>
        </Paper>

        {/* ---------------------------------------------------------------- */}
        {/* Section 2: Suggestions                                            */}
        {/* ---------------------------------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 1 }}
          >
            <Typography variant="h6">Suggestions</Typography>
            <Button size="small" startIcon={<RefreshIcon />} onClick={loadSuggestions}>
              Refresh suggestions
            </Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Clusters of ungrouped raw values that look like the same place. Adjust the proposed name
            if you like, then merge them into one group.
          </Typography>

          {suggestionsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : visibleSuggestions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No grouping suggestions for this level.
            </Typography>
          ) : (
            <Stack spacing={2}>
              {visibleSuggestions.map((suggestion) => {
                const key = suggestionKeyOf(suggestion);
                return (
                  <Paper
                    key={key}
                    variant="outlined"
                    sx={{ p: 2, minWidth: 0 }}
                    data-testid={`suggestion-${key}`}
                  >
                    <Typography variant="body2" sx={{ mb: 1, wordBreak: 'break-word' }}>
                      {suggestion.members.map((m) => m.value).join(' · ')} —{' '}
                      {suggestion.totalItems.toLocaleString()} photos
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
                      {suggestion.members.map((member) => (
                        <Chip
                          key={member.value}
                          size="small"
                          label={`${member.value} (${member.itemCount})`}
                        />
                      ))}
                      {suggestion.countryCode && (
                        <Chip size="small" variant="outlined" label={suggestion.countryCode} />
                      )}
                    </Box>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                      <TextField
                        size="small"
                        label="Canonical name"
                        value={suggestionNames[key] ?? suggestion.suggestedCanonicalName}
                        onChange={(e) =>
                          setSuggestionNames((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        sx={{ flex: 1, minWidth: 0 }}
                      />
                      <Button
                        variant="contained"
                        onClick={() => void handleMerge(suggestion)}
                        disabled={mergingKey === key}
                        startIcon={
                          mergingKey === key ? <CircularProgress size={16} /> : <AddIcon />
                        }
                      >
                        Merge
                      </Button>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Paper>

        {/* ---------------------------------------------------------------- */}
        {/* Section 3: Groups                                                 */}
        {/* ---------------------------------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 2 }}
          >
            <Typography variant="h6">Groups</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ minWidth: 0 }}>
              <TextField
                size="small"
                label="Search groups"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => {
                  setEditorGroupId(null);
                  setEditorOpen(true);
                }}
              >
                New group
              </Button>
            </Stack>
          </Stack>

          {groupsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : groups.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No location groups at this level yet.
            </Typography>
          ) : (
            <Stack divider={<Divider />} spacing={0}>
              {groups.map((group) => (
                <Box
                  key={group.id}
                  data-testid={`group-row-${group.id}`}
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 1,
                    py: 1.5,
                    minWidth: 0,
                  }}
                >
                  <Avatar
                    variant="rounded"
                    src={group.coverThumbnailUrl ?? undefined}
                    alt={group.canonicalName}
                    sx={{ width: 44, height: 44 }}
                  />
                  <Box sx={{ flex: 1, minWidth: 140 }}>
                    <Typography variant="subtitle2" sx={{ wordBreak: 'break-word' }}>
                      {group.canonicalName}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                      <Chip size="small" label={`${group.memberCount} members`} />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${group.itemCount.toLocaleString()} photos`}
                      />
                      {group.countryCode && (
                        <Chip size="small" variant="outlined" label={group.countryCode} />
                      )}
                      {group.radiusKm !== null && (
                        <Chip size="small" variant="outlined" label={`${group.radiusKm} km area`} />
                      )}
                    </Box>
                  </Box>
                  <Switch
                    checked={group.enabled}
                    onChange={(e) => void handleToggleGroup(group, e.target.checked)}
                    slotProps={{ input: { 'aria-label': `Enable ${group.canonicalName}` } }}
                  />
                  <Tooltip title="Edit group">
                    <IconButton
                      aria-label={`Edit ${group.canonicalName}`}
                      onClick={() => {
                        setEditorGroupId(group.id);
                        setEditorOpen(true);
                      }}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete group">
                    <IconButton
                      aria-label={`Delete ${group.canonicalName}`}
                      onClick={() => void handleDeleteGroup(group)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          )}
        </Paper>

        {/* ---------------------------------------------------------------- */}
        {/* Section 4: Rebuild                                                */}
        {/* ---------------------------------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Rebuild Canonical Names
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Every group edit already queues a rebuild automatically. Run one explicitly after a bulk
            geocode backfill, when stored canonical names may be stale.
          </Typography>

          {rebuildJobId && (
            <Alert severity={rebuildStatus === 'failed' ? 'error' : 'info'} sx={{ mb: 2 }}>
              Rebuild job {rebuildJobId} — {rebuildStatus ?? 'pending'}
            </Alert>
          )}

          <Button
            variant="contained"
            onClick={handleRebuild}
            disabled={rebuildLoading}
            startIcon={rebuildLoading ? <CircularProgress size={16} /> : <RefreshIcon />}
          >
            Rebuild Now
          </Button>
        </Paper>
      </Box>

      <LocationGroupEditorDialog
        open={editorOpen}
        groupId={editorGroupId}
        level={level}
        maxRadiusKm={effectiveMaxRadiusKm}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          loadGroups();
          loadSuggestions();
          setSuccessMessage('Location group saved');
        }}
      />

      {/* Success Snackbar */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      {/* Error Snackbar */}
      <Snackbar open={!!localError} autoHideDuration={6000} onClose={() => setLocalError(null)}>
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

/**
 * Stable identity for a suggestion cluster. Suggestions are stateless server
 * side (there is no id), so the country scope plus the member set is the only
 * thing that identifies one across a re-render or a refetch.
 */
function suggestionKeyOf(suggestion: LocationGroupSuggestion): string {
  return `${suggestion.countryCode ?? ''}|${suggestion.members.map((m) => m.value).join('|')}`;
}

export default function LocationGroupsSettingsPage() {
  const { isAdmin, hasPermission } = usePermissions();

  if (!isAdmin || !hasPermission('geo_settings:read')) {
    return <Navigate to="/" replace />;
  }

  return <LocationGroupsSettingsContent />;
}
