/**
 * Settings → Notifications (`/settings/notifications`), RETRO-B5 #621; the
 * preferences are issue #251's. `NotificationPermissionBanner` links here
 * (`NOTIFICATION_SETTINGS_LINK`) and stays hidden on this route.
 */
import { NotificationSettings } from '../../components/settings/NotificationSettings';
import { UserSettingsCardPage } from './UserSettingsCardPage';

export default function NotificationPreferencesPage() {
  return (
    <UserSettingsCardPage
      title="Notifications"
      description="Choose which notifications you receive, in the app and on this device."
    >
      {({ settings, isSaving, updateSettings, notifySaved }) => (
        <NotificationSettings
          settings={settings}
          updateSettings={updateSettings}
          onSaved={notifySaved}
          disabled={isSaving}
        />
      )}
    </UserSettingsCardPage>
  );
}
