/**
 * Settings → Notifications (`/settings/notifications`), RETRO-B5 #621.
 *
 * Since RETRO-D3 (#576) the preference matrix (per event, per channel: in-app
 * and push) and the "On this device" block are the platform notifications
 * slice's `UserNotificationsPage`. MemoriaHub adds one card after it: the
 * opt-in for `on_media_enriched` workflow micro-run notifications
 * (`memoriahubNotifications.workflowMicroRuns`, absent means OFF), which has no
 * platform equivalent.
 */
import { useState } from 'react';
import { Alert, Card, CardContent, FormControlLabel, Switch, Typography } from '@mui/material';
import { UserNotificationsPage } from '@marinoscar/platform-web/notifications/ui';
import { useUserSettings } from '../../hooks/useUserSettings';

/** The workflow micro-run opt-in (issue #251's inverted default). */
export function WorkflowMicroRunsCard() {
  const { settings, isSaving, updateSettings } = useUserSettings({ syncTheme: false });
  const [error, setError] = useState<string | null>(null);
  const enabled = settings?.memoriahubNotifications?.workflowMicroRuns === true;

  const handleChange = async (next: boolean) => {
    setError(null);
    try {
      await updateSettings({ memoriahubNotifications: { workflowMicroRuns: next } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the preference');
    }
  };

  return (
    <Card variant="outlined" sx={{ mt: 3 }}>
      <CardContent>
        <Typography variant="h6" component="h2" gutterBottom>
          Automatic workflow runs
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Workflows that run whenever new photos finish processing start small runs continuously during an
          import. They do not notify you unless you turn this on.
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={enabled}
              disabled={!settings || isSaving}
              onChange={(event) => void handleChange(event.target.checked)}
            />
          }
          label="Notify me when an automatic workflow run finishes"
        />
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export default function NotificationPreferencesPage() {
  return <UserNotificationsPage slots={{ AfterContent: WorkflowMicroRunsCard }} />;
}
