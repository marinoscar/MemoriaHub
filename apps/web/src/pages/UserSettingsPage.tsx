import {
  Container,
  Typography,
  Box,
  Alert,
  Snackbar,
} from '@mui/material';
import { useState } from 'react';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { TimezoneSettings } from '../components/settings/TimezoneSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { SearchFieldsSettings } from '../components/settings/SearchFieldsSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { MemoriesSettings } from '../components/settings/MemoriesSettings';
import { PersonalAccessTokens } from '../components/settings/PersonalAccessTokens';
import { useUserSettings } from '../hooks/useUserSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export default function UserSettingsPage() {
  const {
    settings,
    isLoading,
    error,
    isSaving,
    updateTheme,
    updateTimezone,
    updateSettings,
  } = useUserSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    try {
      await updateTheme(theme);
      setSuccessMessage('Theme updated');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update theme');
    }
  };

  const handleTimezoneChange = async (timezone: string) => {
    try {
      await updateTimezone(timezone);
      setSuccessMessage('Time zone updated');
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Failed to update time zone',
      );
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Manage your account preferences
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Theme Settings */}
            <ThemeSettings
              currentTheme={settings.theme}
              onThemeChange={handleThemeChange}
              disabled={isSaving}
            />

            {/* Time zone (issue #444) — sits beside Appearance because both
                are app-behaviour preferences rather than profile data. */}
            <TimezoneSettings
              currentTimezone={settings.timezone}
              onTimezoneChange={handleTimezoneChange}
              disabled={isSaving}
            />

            {/* Profile summary — editing lives at /profile (issue #354) */}
            <ProfileSettings />

            {/* Notification Preferences (issue #251) */}
            <NotificationSettings
              settings={settings}
              updateSettings={updateSettings}
              onSaved={setSuccessMessage}
              disabled={isSaving}
            />

            {/* Memory Preferences (issue #313) — self-hiding when the
                `features.memories` flag is off. */}
            <MemoriesSettings
              settings={settings}
              updateSettings={updateSettings}
              onSaved={setSuccessMessage}
              disabled={isSaving}
            />

            {/* Search Field Preferences */}
            <Box id="search-fields">
              <SearchFieldsSettings
                settings={settings}
                updateSettings={updateSettings}
                disabled={isSaving}
              />
            </Box>

            {/* Personal Access Tokens */}
            <PersonalAccessTokens />
          </Box>
        )}

        {/* Success Snackbar */}
        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        {/* Error Snackbar */}
        <Snackbar
          open={!!localError}
          autoHideDuration={5000}
          onClose={() => setLocalError(null)}
        >
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}
