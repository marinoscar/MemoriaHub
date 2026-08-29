import { useState, useEffect, useCallback } from 'react';
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
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import RefreshIcon from '@mui/icons-material/Refresh';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { getEnhancerAdminStatus } from '../../services/enhance';
import type { EnhancerAdminStatus } from '../../services/enhance';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';

type Quality = 'low' | 'medium' | 'high';
type Strength = 'subtle' | 'balanced' | 'strong';

// Ranges mirror the server zod schema (apps/api/src/common/schemas/settings.schema.ts).
const MAX_MP_MIN = 1;
const MAX_MP_MAX = 100;
const RETENTION_MIN = 1;
const RETENTION_MAX = 720;

function EnhancerSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('system_settings:write');

  // Readiness panel
  const [status, setStatus] = useState<EnhancerAdminStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Defaults & policy local state
  const [defaultQuality, setDefaultQuality] = useState<Quality>('high');
  const [defaultStrength, setDefaultStrength] = useState<Strength>('balanced');
  const [stampExif, setStampExif] = useState(true);
  const [allowReplace, setAllowReplace] = useState(true);
  const [blockReplaceOnDownscale, setBlockReplaceOnDownscale] = useState(false);
  const [maxInputMegapixels, setMaxInputMegapixels] = useState('50');
  // Mirrors the server default (settings.schema.ts), raised to 168h in #201.
  // Keeping a stale 72 here would silently downgrade a 7-day retention to 3
  // days on the next save if the server ever omitted the field.
  const [retentionHours, setRetentionHours] = useState('168');
  const [paramSaving, setParamSaving] = useState(false);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    setStatusLoading(true);
    setStatusError(null);
    getEnhancerAdminStatus()
      .then(setStatus)
      .catch((err: unknown) => {
        setStatusError(
          err instanceof Error ? err.message : 'Failed to load enhancer status',
        );
      })
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Sync form fields from settings
  useEffect(() => {
    if (!settings) return;
    const pe = settings.pictureEnhancement;
    setDefaultQuality(pe?.defaultQuality ?? 'high');
    setDefaultStrength(pe?.defaultStrength ?? 'balanced');
    setStampExif(pe?.stampExif ?? true);
    setAllowReplace(pe?.allowReplace ?? true);
    setBlockReplaceOnDownscale(pe?.blockReplaceOnDownscale ?? false);
    setMaxInputMegapixels(String(pe?.maxInputMegapixels ?? 50));
    setRetentionHours(String(pe?.retentionHours ?? 168));
  }, [settings]);

  const featureEnabled = settings?.features?.pictureEnhancement ?? false;

  // ---- Client-side validation of the two numeric inputs --------------------
  const megapixelsValue = Number(maxInputMegapixels);
  const megapixelsError =
    maxInputMegapixels.trim() === '' ||
    !Number.isFinite(megapixelsValue) ||
    megapixelsValue < MAX_MP_MIN ||
    megapixelsValue > MAX_MP_MAX
      ? `Enter a number between ${MAX_MP_MIN} and ${MAX_MP_MAX}.`
      : null;

  const retentionValue = Number(retentionHours);
  const retentionError =
    retentionHours.trim() === '' ||
    !Number.isInteger(retentionValue) ||
    retentionValue < RETENTION_MIN ||
    retentionValue > RETENTION_MAX
      ? `Enter a whole number of hours between ${RETENTION_MIN} and ${RETENTION_MAX}.`
      : null;

  const hasValidationError = !!megapixelsError || !!retentionError;

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), pictureEnhancement: checked },
    })
      .then(() => {
        // Readiness depends on the toggle — refresh so the panel matches.
        loadStatus();
      })
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      });
  };

  const handleSaveParams = () => {
    if (hasValidationError) return;
    setParamSaving(true);
    updateSettings({
      pictureEnhancement: {
        ...(settings?.pictureEnhancement ?? {}),
        defaultQuality,
        defaultStrength,
        stampExif,
        allowReplace,
        blockReplaceOnDownscale,
        maxInputMegapixels: megapixelsValue,
        retentionHours: retentionValue,
      },
    })
      .then(() => setSuccessMessage('Picture enhancer settings saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      })
      .finally(() => setParamSaving(false));
  };

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
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          icon={<AutoFixHighIcon color="primary" />}
          title={<>AI Picture Enhancer</>}
          description={
            <>
              Turn the enhancer on, confirm the OpenAI image model is configured, and set the
              defaults users start from.
            </>
          }
        />

        {/* Section A: Master toggle */}
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
            label="Enable AI picture enhancement globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Lets a user pick a single photo and ask an AI model to improve it. The result is
            staged as a preview for side-by-side review — the user then chooses to keep the
            enhanced copy alongside the original, replace the original, or discard it. Nothing
            is ever enhanced or applied automatically, and no bulk enhancement exists.
          </Typography>
        </Paper>

        {/* Section B: Readiness */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              mb: 2,
            }}
          >
            <Typography variant="h6">Readiness</Typography>
            <Button
              size="small"
              startIcon={statusLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
              onClick={loadStatus}
              disabled={statusLoading}
            >
              Refresh
            </Button>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The toggle above is only half of it — enhancement also needs an OpenAI image model
            selected and an enabled credential for that provider. Without both, every enhance
            request fails.
          </Typography>

          {statusError && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={loadStatus} disabled={statusLoading}>
                  Retry
                </Button>
              }
            >
              {statusError}
            </Alert>
          )}

          {!statusError && !status && statusLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {!statusError && status && (
            <>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', mb: 2 }}
              >
                <Chip
                  size="small"
                  label={`Feature: ${status.featureEnabled ? 'enabled' : 'disabled'}`}
                  color={status.featureEnabled ? 'success' : 'default'}
                  variant={status.featureEnabled ? 'filled' : 'outlined'}
                />
                <Chip
                  size="small"
                  label={`Provider: ${status.provider ?? 'not set'}`}
                  color={status.provider ? 'success' : 'warning'}
                  variant={status.provider ? 'filled' : 'outlined'}
                />
                <Chip
                  size="small"
                  label={`Model: ${status.model ?? 'not set'}`}
                  color={status.model ? 'success' : 'warning'}
                  variant={status.model ? 'filled' : 'outlined'}
                />
                <Chip
                  size="small"
                  label={`Credential: ${status.credentialConfigured ? 'configured' : 'missing'}`}
                  color={status.credentialConfigured ? 'success' : 'warning'}
                  variant={status.credentialConfigured ? 'filled' : 'outlined'}
                />
              </Stack>

              {status.ready ? (
                <Alert severity="success">
                  <AlertTitle>Ready</AlertTitle>
                  Enhancement is enabled and{' '}
                  <strong>{status.model}</strong>
                  {status.provider ? ` (${status.provider})` : ''} is configured. Users can
                  enhance photos from the gallery selection bar and the full-screen viewer.
                </Alert>
              ) : (
                <Alert severity="warning">
                  <AlertTitle>Not ready</AlertTitle>
                  <Box component="ul" sx={{ pl: 2.5, m: 0 }}>
                    {!status.featureEnabled && (
                      <li>
                        The global toggle above is off — turn it on to expose the enhance action.
                      </li>
                    )}
                    {!status.model && (
                      <li>
                        No image model is selected. Pick one under{' '}
                        <Link component={RouterLink} to="/admin/settings/ai" underline="hover">
                          AI Providers &rarr; AI Picture Enhancer
                        </Link>
                        .
                      </li>
                    )}
                    {!status.credentialConfigured && (
                      <li>
                        No enabled credential for{' '}
                        {status.provider ? <strong>{status.provider}</strong> : 'the image provider'}
                        . Add or enable it under{' '}
                        <Link component={RouterLink} to="/admin/settings/ai" underline="hover">
                          AI Providers
                        </Link>
                        .
                      </li>
                    )}
                  </Box>
                </Alert>
              )}
            </>
          )}
        </Paper>

        {/* Section C: Defaults & policy */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Defaults &amp; Policy
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
            <FormControl size="small" sx={{ flex: 1 }} disabled={!canManage}>
              <InputLabel id="enhancer-quality-label">Default quality</InputLabel>
              <Select
                labelId="enhancer-quality-label"
                label="Default quality"
                value={defaultQuality}
                onChange={(e) => setDefaultQuality(e.target.value as Quality)}
              >
                <MenuItem value="low">Low</MenuItem>
                <MenuItem value="medium">Medium</MenuItem>
                <MenuItem value="high">High</MenuItem>
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ flex: 1 }} disabled={!canManage}>
              <InputLabel id="enhancer-strength-label">Default strength</InputLabel>
              <Select
                labelId="enhancer-strength-label"
                label="Default strength"
                value={defaultStrength}
                onChange={(e) => setDefaultStrength(e.target.value as Strength)}
              >
                <MenuItem value="subtle">Subtle</MenuItem>
                <MenuItem value="balanced">Balanced</MenuItem>
                <MenuItem value="strong">Strong</MenuItem>
              </Select>
            </FormControl>
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Quality controls how much the model spends on the output; strength controls how
            aggressively the photo is corrected. Users can override both per enhancement.
          </Typography>

          <Divider sx={{ mb: 2 }} />

          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={stampExif}
                  onChange={(e) => setStampExif(e.target.checked)}
                  disabled={!canManage}
                />
              }
              label="Carry EXIF metadata onto the enhanced file"
              sx={{ display: 'block' }}
            />
            <Typography variant="body2" color="text.secondary">
              Writes the original photo&rsquo;s EXIF (capture date, GPS, camera) onto the enhanced
              file, plus a standard &ldquo;AI enhanced&rdquo; marker, so a downloaded copy keeps its
              metadata.
            </Typography>
          </Box>

          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={allowReplace}
                  onChange={(e) => setAllowReplace(e.target.checked)}
                  disabled={!canManage}
                />
              }
              label="Allow replacing the original"
              sx={{ display: 'block' }}
            />
            <Typography variant="body2" color="text.secondary">
              When off, users may only keep the enhanced copy alongside the original; the
              destructive replace action is hidden entirely.
            </Typography>
          </Box>

          <Box sx={{ mb: 3 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={blockReplaceOnDownscale}
                  onChange={(e) => setBlockReplaceOnDownscale(e.target.checked)}
                  disabled={!canManage || !allowReplace}
                />
              }
              label="Block replace when the result is lower resolution"
              sx={{ display: 'block' }}
            />
            <Typography variant="body2" color="text.secondary">
              The image model caps its output at roughly 1.6 megapixels, so an enhanced photo is
              smaller than essentially <em>every</em> real photo — anything above ~1.6 MP, which
              includes any phone or scanner image. Turning this on therefore affects nearly every
              enhancement, not a rare edge case. Users are still told exactly what resolution they
              would lose and can go ahead after confirming it — the switch above is the one that
              forbids replacing outright.
            </Typography>
          </Box>

          <Divider sx={{ mb: 2 }} />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Max input megapixels"
              type="number"
              size="small"
              value={maxInputMegapixels}
              onChange={(e) => setMaxInputMegapixels(e.target.value)}
              error={!!megapixelsError}
              helperText={
                megapixelsError ??
                `Photos larger than this are rejected before the model call. ${MAX_MP_MIN}-${MAX_MP_MAX}.`
              }
              slotProps={{ htmlInput: { min: MAX_MP_MIN, max: MAX_MP_MAX } }}
              disabled={!canManage}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Preview retention (hours)"
              type="number"
              size="small"
              value={retentionHours}
              onChange={(e) => setRetentionHours(e.target.value)}
              error={!!retentionError}
              helperText={
                retentionError ??
                `How long an unreviewed enhanced preview is kept before it is automatically deleted. ${RETENTION_MIN}-${RETENTION_MAX}.`
              }
              slotProps={{ htmlInput: { min: RETENTION_MIN, max: RETENTION_MAX, step: 1 } }}
              disabled={!canManage}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Button
            variant="contained"
            disabled={isSaving || paramSaving || !settings || !canManage || hasValidationError}
            startIcon={paramSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveParams}
          >
            Save Settings
          </Button>
        </Paper>
      </Box>

      {/* Success Snackbar */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      {/* Error Snackbar */}
      <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function EnhancerSettingsPage() {
  const { isAdmin, hasPermission } = usePermissions();

  if (!isAdmin || !hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  return <EnhancerSettingsContent />;
}
