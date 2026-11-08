/** Settings → Appearance (`/settings/appearance`), RETRO-B5 #621. */
import { ThemeSettings } from '../../components/settings/ThemeSettings';
import { UserSettingsCardPage, errorMessage } from './UserSettingsCardPage';

export default function AppearanceSettingsPage() {
  return (
    <UserSettingsCardPage
      title="Appearance"
      description="Choose a light, dark, or system-matched theme."
    >
      {({ settings, isSaving, updateTheme, notifySaved, notifyError }) => (
        <ThemeSettings
          currentTheme={settings.theme}
          onThemeChange={async (theme) => {
            try {
              await updateTheme(theme);
              notifySaved('Theme updated');
            } catch (err) {
              notifyError(errorMessage(err, 'Failed to update theme'));
            }
          }}
          disabled={isSaving}
        />
      )}
    </UserSettingsCardPage>
  );
}
