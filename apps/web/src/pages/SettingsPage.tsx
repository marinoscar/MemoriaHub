import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Switch,
  Divider,
  Select,
  MenuItem,
  FormControl,
  Alert,
  Snackbar,
  CircularProgress,
  Button,
  Chip,
} from '@mui/material';
import {
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  Notifications as NotificationsIcon,
  Email as EmailIcon,
  PhoneAndroid as PushIcon,
  Security as SecurityIcon,
  GridView as GridViewIcon,
  Restore as RestoreIcon,
} from '@mui/icons-material';
import { useTheme, useAuth } from '../hooks';
import { settingsApi } from '../services/api/settings.api';
import type { UserPreferencesDTO } from '@memoriahub/shared';

/**
 * Grid size options
 */
const GRID_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/**
 * Settings page
 *
 * Allows users to configure their preferences:
 * - Appearance (theme, grid size, metadata)
 * - Notifications (email, push)
 * - Privacy settings (album visibility, tagging)
 */
export function SettingsPage() {
  const { isDarkMode, setTheme } = useTheme();
  const { isAuthenticated } = useAuth();

  // State
  const [preferences, setPreferences] = useState<UserPreferencesDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load preferences on mount
  useEffect(() => {
    if (isAuthenticated) {
      loadPreferences();
    }
  }, [isAuthenticated]);

  const loadPreferences = async () => {
    try {
      setLoading(true);
      setError(null);
      const prefs = await settingsApi.getPreferences();
      setPreferences(prefs);

      // Sync theme with server preference
      if (prefs.preferences.ui.theme === 'dark' && !isDarkMode) {
        setTheme('dark');
      } else if (prefs.preferences.ui.theme === 'light' && isDarkMode) {
        setTheme('light');
      }
    } catch (err) {
      console.error('Failed to load preferences:', err);
      setError('Failed to load preferences');
    } finally {
      setLoading(false);
    }
  };

  const updatePreference = useCallback(
    async (path: string[], value: unknown) => {
      if (!preferences) return;

      try {
        setSaving(true);
        setError(null);

        // Build nested update object
        const update: Record<string, unknown> = {};
        let current = update;
        for (let i = 0; i < path.length - 1; i++) {
          current[path[i]] = {};
          current = current[path[i]] as Record<string, unknown>;
        }
        current[path[path.length - 1]] = value;

        const updated = await settingsApi.updatePreferences(update);
        setPreferences(updated);
        setSuccess('Settings saved');
      } catch (err) {
        console.error('Failed to save preference:', err);
        setError('Failed to save settings');
      } finally {
        setSaving(false);
      }
    },
    [preferences]
  );

  const handleThemeChange = useCallback(
    async (newTheme: 'dark' | 'light' | 'system') => {
      // Update local theme immediately
      if (newTheme === 'dark') {
        setTheme('dark');
      } else if (newTheme === 'light') {
        setTheme('light');
      } else {
        // System preference - check media query
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setTheme(prefersDark ? 'dark' : 'light');
      }

      // Save to server
      await updatePreference(['ui', 'theme'], newTheme);
    },
    [setTheme, updatePreference]
  );

  const handleResetPreferences = async () => {
    try {
      setSaving(true);
      setError(null);
      const reset = await settingsApi.resetPreferences();
      setPreferences(reset);
      setSuccess('Preferences reset to defaults');

      // Sync theme
      if (reset.preferences.ui.theme === 'dark') {
        setTheme('dark');
      } else {
        setTheme('light');
      }
    } catch (err) {
      console.error('Failed to reset preferences:', err);
      setError('Failed to reset preferences');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const prefs = preferences?.preferences;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4" component="h1">
          Settings
        </Typography>
        <Button
          variant="outlined"
          startIcon={<RestoreIcon />}
          onClick={handleResetPreferences}
          disabled={saving}
          size="small"
        >
          Reset to Defaults
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Appearance */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Appearance</Typography>
        </Box>
        <Divider />
        <List>
          {/* Theme */}
          <ListItem>
            <ListItemIcon>
              {isDarkMode ? <DarkModeIcon /> : <LightModeIcon />}
            </ListItemIcon>
            <ListItemText
              primary="Theme"
              secondary="Choose your preferred color scheme"
            />
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <Select
                value={prefs?.ui.theme || 'dark'}
                onChange={(e) => handleThemeChange(e.target.value as 'dark' | 'light' | 'system')}
                disabled={saving}
              >
                <MenuItem value="dark">Dark</MenuItem>
                <MenuItem value="light">Light</MenuItem>
                <MenuItem value="system">System</MenuItem>
              </Select>
            </FormControl>
          </ListItem>

          {/* Grid Size */}
          <ListItem>
            <ListItemIcon>
              <GridViewIcon />
            </ListItemIcon>
            <ListItemText
              primary="Grid Size"
              secondary="Photo grid thumbnail size"
            />
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <Select
                value={prefs?.ui.gridSize || 'medium'}
                onChange={(e) => updatePreference(['ui', 'gridSize'], e.target.value)}
                disabled={saving}
              >
                {GRID_SIZES.map((size) => (
                  <MenuItem key={size.value} value={size.value}>
                    {size.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </ListItem>

          {/* Show Metadata */}
          <ListItem>
            <ListItemIcon>
              <SecurityIcon />
            </ListItemIcon>
            <ListItemText
              primary="Show Metadata"
              secondary="Display EXIF data and file info"
            />
            <Switch
              checked={prefs?.ui.showMetadata ?? true}
              onChange={(e) => updatePreference(['ui', 'showMetadata'], e.target.checked)}
              disabled={saving}
              edge="end"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Notifications */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6">Notifications</Typography>
          <Chip label="Requires SMTP" size="small" variant="outlined" />
        </Box>
        <Divider />
        <List>
          {/* Email Notifications */}
          <ListItem>
            <ListItemIcon>
              <EmailIcon />
            </ListItemIcon>
            <ListItemText
              primary="Email Notifications"
              secondary="Receive email updates about your libraries"
            />
            <Switch
              checked={prefs?.notifications.email.enabled ?? false}
              onChange={(e) =>
                updatePreference(['notifications', 'email', 'enabled'], e.target.checked)
              }
              disabled={saving}
              edge="end"
            />
          </ListItem>

          {/* Email Digest */}
          {prefs?.notifications.email.enabled && (
            <ListItem sx={{ pl: 9 }}>
              <ListItemText
                primary="Email Digest"
                secondary="How often to receive email summaries"
              />
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <Select
                  value={prefs?.notifications.email.digest || 'daily'}
                  onChange={(e) =>
                    updatePreference(['notifications', 'email', 'digest'], e.target.value)
                  }
                  disabled={saving}
                >
                  <MenuItem value="instant">Instant</MenuItem>
                  <MenuItem value="daily">Daily</MenuItem>
                  <MenuItem value="weekly">Weekly</MenuItem>
                  <MenuItem value="never">Never</MenuItem>
                </Select>
              </FormControl>
            </ListItem>
          )}

          {/* Push Notifications */}
          <ListItem>
            <ListItemIcon>
              <PushIcon />
            </ListItemIcon>
            <ListItemText
              primary="Push Notifications"
              secondary="Receive push notifications on your devices"
            />
            <Switch
              checked={prefs?.notifications.push.enabled ?? false}
              onChange={(e) =>
                updatePreference(['notifications', 'push', 'enabled'], e.target.checked)
              }
              disabled={saving}
              edge="end"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Privacy */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Privacy</Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemIcon>
              <SecurityIcon />
            </ListItemIcon>
            <ListItemText
              primary="Default Album Visibility"
              secondary="Privacy setting for new albums"
            />
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <Select
                value={prefs?.privacy.defaultAlbumVisibility || 'private'}
                onChange={(e) =>
                  updatePreference(['privacy', 'defaultAlbumVisibility'], e.target.value)
                }
                disabled={saving}
              >
                <MenuItem value="private">Private</MenuItem>
                <MenuItem value="shared">Shared</MenuItem>
                <MenuItem value="public">Public</MenuItem>
              </Select>
            </FormControl>
          </ListItem>

          <ListItem>
            <ListItemIcon>
              <NotificationsIcon />
            </ListItemIcon>
            <ListItemText
              primary="Allow Tagging"
              secondary="Let others tag you in photos"
            />
            <Switch
              checked={prefs?.privacy.allowTagging ?? true}
              onChange={(e) => updatePreference(['privacy', 'allowTagging'], e.target.checked)}
              disabled={saving}
              edge="end"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Success Snackbar */}
      <Snackbar
        open={!!success}
        autoHideDuration={3000}
        onClose={() => setSuccess(null)}
        message={success}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />

      {/* Saving Indicator */}
      {saving && (
        <Box
          sx={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            bgcolor: 'background.paper',
            px: 2,
            py: 1,
            borderRadius: 2,
            boxShadow: 3,
          }}
        >
          <CircularProgress size={20} />
          <Typography variant="body2">Saving...</Typography>
        </Box>
      )}
    </Box>
  );
}
