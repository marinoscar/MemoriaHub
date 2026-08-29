import { useState, useEffect, useCallback, useMemo } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  Switch,
  FormControl,
  FormControlLabel,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  CircularProgress,
  Alert,
  AlertTitle,
  Snackbar,
  Link,
  Divider,
} from '@mui/material';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useAiSettings } from '../../hooks/useAiSettings';
import { getEmailSettings } from '../../services/email';
import { listCircles } from '../../services/circles';
import { runMemoriesBackfill } from '../../services/adminMemories';
import type { MemoriesBackfillResult } from '../../services/adminMemories';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';

type DigestFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

// ---------------------------------------------------------------------------
// Bounds
//
// Every pair below mirrors the zod schema in
// apps/api/src/common/schemas/settings.schema.ts. They are duplicated here on
// purpose — the alternative is a page that lets an admin type a value the API
// rejects with an opaque 400 — but they are the THIRD hand-maintained copy of
// this namespace (see docs/specs/memories.md §9.3), so a bound changed on the
// server has to be changed here too.
// ---------------------------------------------------------------------------
const BOUNDS = {
  intervalHours: [1, 168],
  maxItemsPerMemory: [5, 100],
  onThisDayLookbackYears: [1, 50],
  onThisDayMinItems: [1, 20],
  tripsMinDays: [1, 14],
  tripsMinItems: [3, 100],
  tripsMinDistanceKm: [5, 500],
  tripsLookbackMonths: [1, 240],
  peopleMinItems: [3, 50],
  themesMinItems: [3, 50],
  themesMaxPerPeriod: [1, 10],
  seasonalMinItems: [5, 100],
  yearInReviewMinItems: [5, 100],
  imageTokenTtlDays: [7, 90],
} as const;

/** Defaults mirror DEFAULT_SYSTEM_SETTINGS.memories. */
const DEFAULTS = {
  intervalHours: 24,
  maxItemsPerMemory: 30,
  aiTitles: true,
  onThisDay: { enabled: true, lookbackYears: 10, minItems: 3 },
  trips: { enabled: true, minDays: 2, minItems: 10, minDistanceKm: 50, lookbackMonths: 18 },
  people: { enabled: true, favoritesOnly: true, minItems: 8 },
  themes: { enabled: true, minItems: 8, maxPerPeriod: 3 },
  seasonal: { enabled: true, minItems: 12 },
  yearInReview: { enabled: true, minItems: 15 },
  digest: {
    enabled: true,
    frequency: 'weekly' as DigestFrequency,
    sendHourUtc: 8,
    imageTokenTtlDays: 30,
  },
};

/** `00:00 UTC` … `23:00 UTC`. */
const SEND_HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

function MemoriesSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('system_settings:write');

  const {
    settings: aiSettings,
    fetchSettings: fetchAiSettings,
    getModels,
    saveMemoriesFeature,
  } = useAiSettings();

  // --- memories.* local state ----------------------------------------------
  const [intervalHours, setIntervalHours] = useState(String(DEFAULTS.intervalHours));
  const [maxItemsPerMemory, setMaxItemsPerMemory] = useState(
    String(DEFAULTS.maxItemsPerMemory),
  );
  const [aiTitlesEnabled, setAiTitlesEnabled] = useState(DEFAULTS.aiTitles);

  const [onThisDay, setOnThisDay] = useState(DEFAULTS.onThisDay);
  const [trips, setTrips] = useState(DEFAULTS.trips);
  const [people, setPeople] = useState(DEFAULTS.people);
  const [themes, setThemes] = useState(DEFAULTS.themes);
  const [seasonal, setSeasonal] = useState(DEFAULTS.seasonal);
  const [yearInReview, setYearInReview] = useState(DEFAULTS.yearInReview);
  const [digest, setDigest] = useState(DEFAULTS.digest);
  const [paramSaving, setParamSaving] = useState(false);

  // --- ai.features.memories -------------------------------------------------
  const [aiProvider, setAiProvider] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [aiModelsLoading, setAiModelsLoading] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);

  // --- email readiness ------------------------------------------------------
  const [emailProvider, setEmailProvider] = useState<string | null>(null);
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const [emailChecked, setEmailChecked] = useState(false);

  // --- backfill -------------------------------------------------------------
  const [backfillCircleId, setBackfillCircleId] = useState('');
  const [circles, setCircles] = useState<Array<{ id: string; name: string }>>([]);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<MemoriesBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // --- feedback -------------------------------------------------------------
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const featureEnabled = settings?.features?.memories ?? false;

  // Sync every field from settings. `?? default` throughout: the whole
  // `memories` namespace is legitimately absent until it is first saved.
  useEffect(() => {
    if (!settings) return;
    const m = settings.memories;
    setIntervalHours(String(m?.generation?.intervalHours ?? DEFAULTS.intervalHours));
    setMaxItemsPerMemory(String(m?.maxItemsPerMemory ?? DEFAULTS.maxItemsPerMemory));
    setAiTitlesEnabled(m?.aiTitles?.enabled ?? DEFAULTS.aiTitles);
    setOnThisDay({
      enabled: m?.onThisDay?.enabled ?? DEFAULTS.onThisDay.enabled,
      lookbackYears: m?.onThisDay?.lookbackYears ?? DEFAULTS.onThisDay.lookbackYears,
      minItems: m?.onThisDay?.minItems ?? DEFAULTS.onThisDay.minItems,
    });
    setTrips({
      enabled: m?.trips?.enabled ?? DEFAULTS.trips.enabled,
      minDays: m?.trips?.minDays ?? DEFAULTS.trips.minDays,
      minItems: m?.trips?.minItems ?? DEFAULTS.trips.minItems,
      minDistanceKm: m?.trips?.minDistanceKm ?? DEFAULTS.trips.minDistanceKm,
      lookbackMonths: m?.trips?.lookbackMonths ?? DEFAULTS.trips.lookbackMonths,
    });
    setPeople({
      enabled: m?.people?.enabled ?? DEFAULTS.people.enabled,
      favoritesOnly: m?.people?.favoritesOnly ?? DEFAULTS.people.favoritesOnly,
      minItems: m?.people?.minItems ?? DEFAULTS.people.minItems,
    });
    setThemes({
      enabled: m?.themes?.enabled ?? DEFAULTS.themes.enabled,
      minItems: m?.themes?.minItems ?? DEFAULTS.themes.minItems,
      maxPerPeriod: m?.themes?.maxPerPeriod ?? DEFAULTS.themes.maxPerPeriod,
    });
    setSeasonal({
      enabled: m?.seasonal?.enabled ?? DEFAULTS.seasonal.enabled,
      minItems: m?.seasonal?.minItems ?? DEFAULTS.seasonal.minItems,
    });
    setYearInReview({
      enabled: m?.yearInReview?.enabled ?? DEFAULTS.yearInReview.enabled,
      minItems: m?.yearInReview?.minItems ?? DEFAULTS.yearInReview.minItems,
    });
    setDigest({
      enabled: m?.digest?.enabled ?? DEFAULTS.digest.enabled,
      frequency: m?.digest?.frequency ?? DEFAULTS.digest.frequency,
      sendHourUtc: m?.digest?.sendHourUtc ?? DEFAULTS.digest.sendHourUtc,
      imageTokenTtlDays: m?.digest?.imageTokenTtlDays ?? DEFAULTS.digest.imageTokenTtlDays,
    });
  }, [settings]);

  useEffect(() => {
    void fetchAiSettings();
  }, [fetchAiSettings]);

  // Reflect the CURRENT ai.features.memories selection on load.
  useEffect(() => {
    if (!aiSettings) return;
    setAiProvider(aiSettings.features?.memories?.provider ?? '');
    setAiModel(aiSettings.features?.memories?.model ?? '');
  }, [aiSettings]);

  // Chat models for whichever provider is selected.
  useEffect(() => {
    if (!aiProvider) {
      setAiModels([]);
      return;
    }
    setAiModelsLoading(true);
    getModels(aiProvider)
      .then(setAiModels)
      .catch(() => setAiModels([]))
      .finally(() => setAiModelsLoading(false));
  }, [aiProvider, getModels]);

  // Email readiness for the digest section. Permission-guarded on the server,
  // and an admin holds it — a failure is treated as "unknown" rather than an
  // error, since the digest section is informational.
  useEffect(() => {
    getEmailSettings()
      .then((email) => {
        setEmailProvider(email.provider);
        setEmailEnabled(email.enabled);
      })
      .catch(() => {
        setEmailProvider(null);
        setEmailEnabled(null);
      })
      .finally(() => setEmailChecked(true));
  }, []);

  // Circle list for the backfill selector. `all=true` needs circles:manage_any,
  // which an Admin has; anything else degrades to "All circles" only.
  useEffect(() => {
    listCircles(true)
      .then((res) => setCircles(res.items.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCircles([]));
  }, []);

  /**
   * Whether the selected AI provider actually has an enabled credential.
   * Without one, titling silently falls back to templates — worth saying out
   * loud rather than letting an admin believe AI titles are live.
   */
  const aiCredentialReady = useMemo(() => {
    if (!aiProvider || !aiSettings) return false;
    return (aiSettings.providers ?? []).some(
      (p) => p.provider === aiProvider && p.configured && p.enabled,
    );
  }, [aiProvider, aiSettings]);

  const providerOptions = useMemo(() => {
    if (!aiSettings) return [] as Array<{ provider: string; configured: boolean }>;
    return [...(aiSettings.providers ?? []), ...(aiSettings.knownProviders ?? [])].map((p) => ({
      provider: p.provider,
      configured: p.configured && p.enabled,
    }));
  }, [aiSettings]);

  const handleGlobalToggle = (checked: boolean) => {
    // Merge-spread, never replace: the features record holds every other
    // feature flag, and assigning a fresh object would clear them all.
    void updateSettings({
      features: { ...(settings?.features ?? {}), memories: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  // One Save for the whole `memories` namespace — simplest, and it keeps the
  // per-type parameters consistent with each other on every write.
  const handleSaveMemories = () => {
    setParamSaving(true);
    updateSettings({
      memories: {
        generation: { intervalHours: Number(intervalHours) },
        maxItemsPerMemory: Number(maxItemsPerMemory),
        aiTitles: { enabled: aiTitlesEnabled },
        onThisDay,
        trips,
        people,
        themes,
        seasonal,
        yearInReview,
        digest,
      },
    })
      .then(() => setSuccessMessage('Memories settings saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      })
      .finally(() => setParamSaving(false));
  };

  const handleSaveAiModel = () => {
    setAiSaving(true);
    // Both nulls clear the selection, which is the documented way back to
    // deterministic template titles.
    saveMemoriesFeature(aiProvider || null, aiModel || null)
      .then(() => {
        setSuccessMessage(
          aiProvider && aiModel
            ? `Memories will be titled by ${aiModel}`
            : 'Memory titles reset to templates',
        );
        return fetchAiSettings();
      })
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save the model');
      })
      .finally(() => setAiSaving(false));
  };

  const handleRunBackfill = useCallback(() => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runMemoriesBackfill(backfillCircleId ? { circleId: backfillCircleId } : {})
      .then(setBackfillResult)
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Backfill failed');
      })
      .finally(() => setBackfillLoading(false));
  }, [backfillCircleId]);

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

  const emailUnconfigured = emailChecked && (!emailProvider || emailEnabled === false);

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          icon={<AutoAwesomeMotionIcon color="primary" />}
          title={<>Memories</>}
          description={
            <>
              Automatic memory curation, story feed, and email digests.
            </>
          }
        />

        {/* ---- Section 1: global toggle ------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={featureEnabled}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings || !canManage}
              />
            }
            label="Enable Memories globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Curates &ldquo;On this day&rdquo;, trips, people, themes, seasons and year-in-review
            collections from every circle&rsquo;s library and surfaces them on Home, in the
            Memories hub, through the notification bell and by email. Off by default &mdash;
            with it off, no background work runs at all and every Memories endpoint returns
            an empty list. The <code>MEMORIES_ENABLED=false</code> environment variable
            overrides this switch and hard-disables the feature regardless of what is saved
            here.
          </Typography>
        </Paper>

        {/* ---- Section 2: AI titles ---------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            AI Titles
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={aiTitlesEnabled}
                onChange={(e) => setAiTitlesEnabled(e.target.checked)}
                disabled={!canManage}
              />
            }
            label="Let an AI model write memory titles"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Writes a warm title, subtitle and short narrative for each memory. When this is
            off &mdash; or the model call fails, times out, or hits a rate limit &mdash;
            memories fall back to deterministic template titles, which is a supported
            configuration, not a broken one.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <FormControl size="small" sx={{ flex: 1 }} disabled={!canManage}>
              <InputLabel id="memories-ai-provider-label">AI provider</InputLabel>
              <Select
                labelId="memories-ai-provider-label"
                label="AI provider"
                value={aiProvider}
                onChange={(e) => {
                  setAiProvider(e.target.value);
                  setAiModel('');
                }}
              >
                <MenuItem value="">
                  <em>None (template titles)</em>
                </MenuItem>
                {providerOptions.map((p) => (
                  <MenuItem key={p.provider} value={p.provider}>
                    {p.provider}
                    {p.configured ? '' : ' (no credential)'}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl
              size="small"
              sx={{ flex: 1 }}
              disabled={!canManage || !aiProvider || aiModelsLoading}
            >
              <InputLabel id="memories-ai-model-label">Model</InputLabel>
              <Select
                labelId="memories-ai-model-label"
                label="Model"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              >
                {aiModelsLoading ? (
                  <MenuItem value="">Loading&hellip;</MenuItem>
                ) : aiModels.length === 0 ? (
                  <MenuItem value="">No models available</MenuItem>
                ) : (
                  aiModels.map((model) => (
                    <MenuItem key={model} value={model}>
                      {model}
                    </MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
          </Stack>

          {aiProvider && !aiCredentialReady && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>No credential for {aiProvider}</AlertTitle>
              Memory titles will keep using templates until an enabled credential exists. Add
              one under{' '}
              <Link component={RouterLink} to="/admin/settings/ai" underline="hover">
                AI Providers
              </Link>
              .
            </Alert>
          )}

          <Button
            variant="outlined"
            disabled={!canManage || aiSaving}
            startIcon={aiSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveAiModel}
          >
            Save AI Model
          </Button>
        </Paper>

        {/* ---- Section 3: generation --------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Generation
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Generation interval (hours)"
              type="number"
              size="small"
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
              helperText={`How often each circle is re-curated. ${BOUNDS.intervalHours[0]}-${BOUNDS.intervalHours[1]}.`}
              slotProps={{
                htmlInput: {
                  min: BOUNDS.intervalHours[0],
                  max: BOUNDS.intervalHours[1],
                },
              }}
              disabled={!canManage}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Max items per memory"
              type="number"
              size="small"
              value={maxItemsPerMemory}
              onChange={(e) => setMaxItemsPerMemory(e.target.value)}
              helperText={`Photos and videos in one memory. ${BOUNDS.maxItemsPerMemory[0]}-${BOUNDS.maxItemsPerMemory[1]}.`}
              slotProps={{
                htmlInput: {
                  min: BOUNDS.maxItemsPerMemory[0],
                  max: BOUNDS.maxItemsPerMemory[1],
                },
              }}
              disabled={!canManage}
              sx={{ flex: 1 }}
            />
          </Stack>
        </Paper>

        {/* ---- Section 4: memory types ------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Memory Types
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each type is generated independently &mdash; turning one off never affects the
            others, and a type with too little material simply produces nothing.
          </Typography>

          {/* On This Day */}
          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={onThisDay.enabled}
                  onChange={(e) =>
                    setOnThisDay((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  disabled={!canManage}
                />
              }
              label="On This Day"
              sx={{ display: 'block' }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Lookback years"
                type="number"
                size="small"
                value={onThisDay.lookbackYears}
                onChange={(e) =>
                  setOnThisDay((prev) => ({ ...prev, lookbackYears: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.onThisDayLookbackYears[0]}-${BOUNDS.onThisDayLookbackYears[1]}`}
                slotProps={{
                  htmlInput: {
                    min: BOUNDS.onThisDayLookbackYears[0],
                    max: BOUNDS.onThisDayLookbackYears[1],
                  },
                }}
                disabled={!canManage || !onThisDay.enabled}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Minimum items"
                type="number"
                size="small"
                value={onThisDay.minItems}
                onChange={(e) =>
                  setOnThisDay((prev) => ({ ...prev, minItems: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.onThisDayMinItems[0]}-${BOUNDS.onThisDayMinItems[1]}`}
                slotProps={{
                  htmlInput: {
                    min: BOUNDS.onThisDayMinItems[0],
                    max: BOUNDS.onThisDayMinItems[1],
                  },
                }}
                disabled={!canManage || !onThisDay.enabled}
                sx={{ flex: 1 }}
              />
            </Stack>
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* Trips */}
          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={trips.enabled}
                  onChange={(e) => setTrips((prev) => ({ ...prev, enabled: e.target.checked }))}
                  disabled={!canManage}
                />
              }
              label="Trips"
              sx={{ display: 'block' }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Minimum days"
                type="number"
                size="small"
                value={trips.minDays}
                onChange={(e) =>
                  setTrips((prev) => ({ ...prev, minDays: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.tripsMinDays[0]}-${BOUNDS.tripsMinDays[1]}`}
                slotProps={{
                  htmlInput: { min: BOUNDS.tripsMinDays[0], max: BOUNDS.tripsMinDays[1] },
                }}
                disabled={!canManage || !trips.enabled}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Minimum items"
                type="number"
                size="small"
                value={trips.minItems}
                onChange={(e) =>
                  setTrips((prev) => ({ ...prev, minItems: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.tripsMinItems[0]}-${BOUNDS.tripsMinItems[1]}`}
                slotProps={{
                  htmlInput: { min: BOUNDS.tripsMinItems[0], max: BOUNDS.tripsMinItems[1] },
                }}
                disabled={!canManage || !trips.enabled}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Minimum distance (km)"
                type="number"
                size="small"
                value={trips.minDistanceKm}
                onChange={(e) =>
                  setTrips((prev) => ({ ...prev, minDistanceKm: Number(e.target.value) }))
                }
                helperText={`From home. ${BOUNDS.tripsMinDistanceKm[0]}-${BOUNDS.tripsMinDistanceKm[1]}`}
                slotProps={{
                  htmlInput: {
                    min: BOUNDS.tripsMinDistanceKm[0],
                    max: BOUNDS.tripsMinDistanceKm[1],
                  },
                }}
                disabled={!canManage || !trips.enabled}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Lookback months"
                type="number"
                size="small"
                value={trips.lookbackMonths}
                onChange={(e) =>
                  setTrips((prev) => ({ ...prev, lookbackMonths: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.tripsLookbackMonths[0]}-${BOUNDS.tripsLookbackMonths[1]}`}
                slotProps={{
                  htmlInput: {
                    min: BOUNDS.tripsLookbackMonths[0],
                    max: BOUNDS.tripsLookbackMonths[1],
                  },
                }}
                disabled={!canManage || !trips.enabled}
                sx={{ flex: 1 }}
              />
            </Stack>
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* People */}
          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={people.enabled}
                  onChange={(e) => setPeople((prev) => ({ ...prev, enabled: e.target.checked }))}
                  disabled={!canManage}
                />
              }
              label="People"
              sx={{ display: 'block' }}
            />
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ mt: 1, alignItems: { sm: 'center' } }}
            >
              <TextField
                label="Minimum items"
                type="number"
                size="small"
                value={people.minItems}
                onChange={(e) =>
                  setPeople((prev) => ({ ...prev, minItems: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.peopleMinItems[0]}-${BOUNDS.peopleMinItems[1]}`}
                slotProps={{
                  htmlInput: { min: BOUNDS.peopleMinItems[0], max: BOUNDS.peopleMinItems[1] },
                }}
                disabled={!canManage || !people.enabled}
                sx={{ flex: 1 }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={people.favoritesOnly}
                    onChange={(e) =>
                      setPeople((prev) => ({ ...prev, favoritesOnly: e.target.checked }))
                    }
                    disabled={!canManage || !people.enabled}
                  />
                }
                label="Favorites only"
                sx={{ flex: 1 }}
              />
            </Stack>
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* Themes */}
          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={themes.enabled}
                  onChange={(e) => setThemes((prev) => ({ ...prev, enabled: e.target.checked }))}
                  disabled={!canManage}
                />
              }
              label="Themes"
              sx={{ display: 'block' }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
              <TextField
                label="Minimum items"
                type="number"
                size="small"
                value={themes.minItems}
                onChange={(e) =>
                  setThemes((prev) => ({ ...prev, minItems: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.themesMinItems[0]}-${BOUNDS.themesMinItems[1]}`}
                slotProps={{
                  htmlInput: { min: BOUNDS.themesMinItems[0], max: BOUNDS.themesMinItems[1] },
                }}
                disabled={!canManage || !themes.enabled}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Max themes per period"
                type="number"
                size="small"
                value={themes.maxPerPeriod}
                onChange={(e) =>
                  setThemes((prev) => ({ ...prev, maxPerPeriod: Number(e.target.value) }))
                }
                helperText={`${BOUNDS.themesMaxPerPeriod[0]}-${BOUNDS.themesMaxPerPeriod[1]}`}
                slotProps={{
                  htmlInput: {
                    min: BOUNDS.themesMaxPerPeriod[0],
                    max: BOUNDS.themesMaxPerPeriod[1],
                  },
                }}
                disabled={!canManage || !themes.enabled}
                sx={{ flex: 1 }}
              />
            </Stack>
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* Seasonal */}
          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={seasonal.enabled}
                  onChange={(e) =>
                    setSeasonal((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  disabled={!canManage}
                />
              }
              label="Seasonal"
              sx={{ display: 'block' }}
            />
            <TextField
              label="Minimum items"
              type="number"
              size="small"
              value={seasonal.minItems}
              onChange={(e) =>
                setSeasonal((prev) => ({ ...prev, minItems: Number(e.target.value) }))
              }
              helperText={`${BOUNDS.seasonalMinItems[0]}-${BOUNDS.seasonalMinItems[1]}`}
              slotProps={{
                htmlInput: {
                  min: BOUNDS.seasonalMinItems[0],
                  max: BOUNDS.seasonalMinItems[1],
                },
              }}
              disabled={!canManage || !seasonal.enabled}
              sx={{ mt: 1, maxWidth: 260 }}
            />
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* Year in Review */}
          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={yearInReview.enabled}
                  onChange={(e) =>
                    setYearInReview((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  disabled={!canManage}
                />
              }
              label="Year in Review"
              sx={{ display: 'block' }}
            />
            <TextField
              label="Minimum items"
              type="number"
              size="small"
              value={yearInReview.minItems}
              onChange={(e) =>
                setYearInReview((prev) => ({ ...prev, minItems: Number(e.target.value) }))
              }
              helperText={`${BOUNDS.yearInReviewMinItems[0]}-${BOUNDS.yearInReviewMinItems[1]}`}
              slotProps={{
                htmlInput: {
                  min: BOUNDS.yearInReviewMinItems[0],
                  max: BOUNDS.yearInReviewMinItems[1],
                },
              }}
              disabled={!canManage || !yearInReview.enabled}
              sx={{ mt: 1, maxWidth: 260 }}
            />
          </Box>
        </Paper>

        {/* ---- Section 5: email digest ------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Email Digest
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={digest.enabled}
                onChange={(e) => setDigest((prev) => ({ ...prev, enabled: e.target.checked }))}
                disabled={!canManage}
              />
            }
            label="Send the memories digest by email"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This switch is global. Each member can still opt out individually in their own
            settings, and the digest is only sent when there is genuinely new content.
          </Typography>

          {emailUnconfigured && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Chip size="small" color="warning" label="Email not configured" sx={{ mr: 1 }} />
              No outbound email provider is enabled, so no digest can be delivered. Set one up
              under{' '}
              <Link component={RouterLink} to="/admin/settings/email" underline="hover">
                Email
              </Link>
              .
            </Alert>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <FormControl size="small" sx={{ flex: 1 }} disabled={!canManage || !digest.enabled}>
              <InputLabel id="memories-digest-frequency-label">Frequency</InputLabel>
              <Select
                labelId="memories-digest-frequency-label"
                label="Frequency"
                value={digest.frequency}
                onChange={(e) =>
                  setDigest((prev) => ({
                    ...prev,
                    frequency: e.target.value as DigestFrequency,
                  }))
                }
              >
                <MenuItem value="off">Off</MenuItem>
                <MenuItem value="daily">Daily</MenuItem>
                <MenuItem value="weekly">Weekly</MenuItem>
                <MenuItem value="monthly">Monthly</MenuItem>
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ flex: 1 }} disabled={!canManage || !digest.enabled}>
              <InputLabel id="memories-digest-hour-label">Send hour (UTC)</InputLabel>
              <Select
                labelId="memories-digest-hour-label"
                label="Send hour (UTC)"
                value={digest.sendHourUtc}
                onChange={(e) =>
                  setDigest((prev) => ({ ...prev, sendHourUtc: Number(e.target.value) }))
                }
              >
                {SEND_HOURS.map((hour) => (
                  <MenuItem key={hour} value={hour}>
                    {String(hour).padStart(2, '0')}:00 UTC
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              label="Image link lifetime (days)"
              type="number"
              size="small"
              value={digest.imageTokenTtlDays}
              onChange={(e) =>
                setDigest((prev) => ({ ...prev, imageTokenTtlDays: Number(e.target.value) }))
              }
              helperText={`How long a sent email's thumbnails keep working. ${BOUNDS.imageTokenTtlDays[0]}-${BOUNDS.imageTokenTtlDays[1]}.`}
              slotProps={{
                htmlInput: {
                  min: BOUNDS.imageTokenTtlDays[0],
                  max: BOUNDS.imageTokenTtlDays[1],
                },
              }}
              disabled={!canManage || !digest.enabled}
              sx={{ flex: 1 }}
            />
          </Stack>
        </Paper>

        {/* ---- Save the whole namespace ------------------------------------ */}
        <Box sx={{ mb: 3 }}>
          <Button
            variant="contained"
            disabled={isSaving || paramSaving || !settings || !canManage}
            startIcon={paramSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveMemories}
          >
            Save Memories Settings
          </Button>
        </Box>

        {/* ---- Section 6: backfill ----------------------------------------- */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2, borderColor: 'warning.main' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Generate Memories From the Existing Library
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Sweeps everything already uploaded, rather than waiting for the schedule to pick
            up today&rsquo;s anniversaries one day at a time. It is idempotent and safe to
            re-run: memories are refreshed in place, per-user state is preserved, and a memory
            someone has deleted is never resurrected. The work is split into several
            background-priority jobs per circle, so it can never starve uploads or time out on
            a large library, and AI titles are capped for the run &mdash; later scheduled runs
            fill the rest in.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <FormControl size="small" sx={{ flex: 1, maxWidth: 360 }} disabled={!canManage}>
              <InputLabel id="memories-backfill-circle-label">Circle</InputLabel>
              <Select
                labelId="memories-backfill-circle-label"
                label="Circle"
                value={backfillCircleId}
                onChange={(e) => setBackfillCircleId(e.target.value)}
              >
                <MenuItem value="">All circles</MenuItem>
                {circles.map((circle) => (
                  <MenuItem key={circle.id} value={circle.id}>
                    {circle.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }} onClose={() => setBackfillResult(null)}>
              {backfillResult.enqueued} job(s) queued across {backfillResult.circles} circle(s)
              {backfillResult.skipped > 0
                ? `, ${backfillResult.skipped} skipped (already generating)`
                : ''}
              .{' '}
              <Link
                component={RouterLink}
                to="/admin/settings/jobs?type=memory_generation"
                underline="hover"
              >
                Watch progress
              </Link>
            </Alert>
          )}
          {backfillError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setBackfillError(null)}>
              {backfillError}
            </Alert>
          )}

          <Button
            variant="contained"
            color="warning"
            disabled={!featureEnabled || !canManage || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Generate Memories From Existing Library
          </Button>
          {!featureEnabled && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Turn Memories on above before running a backfill.
            </Typography>
          )}
        </Paper>
      </Box>

      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function MemoriesSettingsPage() {
  const { isAdmin, hasPermission } = usePermissions();

  if (!isAdmin || !hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  return <MemoriesSettingsContent />;
}
