import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Button,
  Switch,
  FormControlLabel,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Snackbar,
  Link,
} from '@mui/material';
import { LocationOn as LocationOnIcon } from '@mui/icons-material';
import { useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';

function GeoSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleProviderChange = (value: 'offline' | 'nominatim') => {
    void updateSettings({
      geo: {
        provider: value,
        forwardSearchEnabled: settings?.geo?.forwardSearchEnabled ?? false,
      },
    })
      .then(() => setSuccessMessage('Geocoding provider saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      });
  };

  const handleForwardSearchChange = (checked: boolean) => {
    void updateSettings({
      geo: {
        provider: settings?.geo?.provider ?? 'offline',
        forwardSearchEnabled: checked,
      },
    })
      .then(() => setSuccessMessage('Forward search setting saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      });
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

  const currentProvider = settings?.geo?.provider ?? 'offline';
  const forwardSearchEnabled = settings?.geo?.forwardSearchEnabled ?? false;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
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
          <LocationOnIcon color="primary" />
          <Typography variant="h4" component="h1">
            Geo Location
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure reverse geocoding and forward location search settings.
        </Typography>

        {/* Section 1: Reverse Geocoding */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Reverse Geocoding
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }} disabled={isSaving || !settings}>
            <InputLabel>Geocoding provider</InputLabel>
            <Select
              label="Geocoding provider"
              value={currentProvider}
              onChange={(e) => handleProviderChange(e.target.value as 'offline' | 'nominatim')}
            >
              <MenuItem value="offline">Offline (on-server GeoNames dataset)</MenuItem>
              <MenuItem value="nominatim">Nominatim (sends GPS coordinates off-server)</MenuItem>
            </Select>
          </FormControl>

          {currentProvider === 'nominatim' && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Nominatim sends GPS coordinates to nominatim.openstreetmap.org. Only enable if your
              privacy policy allows this.
            </Alert>
          )}

          <Button
            variant="outlined"
            size="small"
            disabled={isSaving || !settings}
            startIcon={isSaving ? <CircularProgress size={14} /> : undefined}
            onClick={() => handleProviderChange(currentProvider)}
          >
            Save
          </Button>
        </Paper>

        {/* Section 2: Forward Search */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Forward Search
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={forwardSearchEnabled}
                onChange={(e) => handleForwardSearchChange(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable forward location search"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Allows users to search by place name (e.g. &lsquo;Paris&rsquo;). Uses Nominatim &mdash;
            only enable if your privacy policy allows off-server requests.
          </Typography>

          {forwardSearchEnabled && (
            <Alert severity="warning">
              Forward search sends typed location queries to nominatim.openstreetmap.org.
            </Alert>
          )}
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

export default function GeoSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <GeoSettingsContent />;
}
