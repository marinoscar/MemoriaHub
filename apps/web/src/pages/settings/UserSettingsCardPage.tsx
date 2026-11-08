/**
 * The chrome every per-user settings card page shares (RETRO-B5, #621): the
 * heading, the load spinner, the fetch-error alert and the two snackbars the
 * stacked `/settings` page used to own. Each card page under `/settings/<card>`
 * renders exactly one of the sections that page stacked; this keeps their
 * behaviour (the same `useUserSettings` document, the same messages) identical.
 *
 * The packaged `UserSettingsSection` is not used: it binds the platform hook
 * with `syncTimeZone` on, which writes `profile.timezone`, while MemoriaHub
 * stores the zone at the top level (`timezone`, absent is not UTC, #444).
 */
import { useState, type ReactNode } from 'react';
import { Alert, Box, Container, Snackbar, Typography } from '@mui/material';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { useUserSettings } from '../../hooks/useUserSettings';

export type UserSettingsCardContext = ReturnType<typeof useUserSettings> & {
  settings: NonNullable<ReturnType<typeof useUserSettings>['settings']>;
  /** Show the success snackbar. */
  notifySaved: (message: string) => void;
  /** Show the error snackbar. */
  notifyError: (message: string) => void;
};

interface UserSettingsCardPageProps {
  title: string;
  description: string;
  children: (context: UserSettingsCardContext) => ReactNode;
}

export function UserSettingsCardPage({ title, description, children }: UserSettingsCardPageProps) {
  const userSettings = useUserSettings();
  const { settings, isLoading, error } = userSettings;
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings &&
          children({
            ...userSettings,
            settings,
            notifySaved: setSuccessMessage,
            notifyError: setLocalError,
          })}

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
      </Box>
    </Container>
  );
}

/** The message of an unknown thrown value, else `fallback`. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
