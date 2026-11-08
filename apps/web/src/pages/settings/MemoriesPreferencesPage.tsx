/**
 * Settings → Memories (`/settings/memories`), RETRO-B5 #621; the preferences
 * are issue #313's. `MemoriesSettings` renders nothing while
 * `features.memories` is off, so the page says so instead of standing empty.
 */
import { Alert } from '@mui/material';
import { MemoriesSettings } from '../../components/settings/MemoriesSettings';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { UserSettingsCardPage } from './UserSettingsCardPage';

export default function MemoriesPreferencesPage() {
  const enabled = useMemoriesEnabled();
  return (
    <UserSettingsCardPage
      title="Memories"
      description="Hide people and dates from your memories, and choose whether you get the email digest."
    >
      {({ settings, isSaving, updateSettings, notifySaved }) =>
        enabled === false ? (
          <Alert severity="info">Memories are turned off for this server.</Alert>
        ) : (
          <MemoriesSettings
            settings={settings}
            updateSettings={updateSettings}
            onSaved={notifySaved}
            disabled={isSaving}
          />
        )
      }
    </UserSettingsCardPage>
  );
}
