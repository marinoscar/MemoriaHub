/**
 * Settings → Time zone (`/settings/time-zone`), RETRO-B5 #621; the setting is
 * issue #444's. MemoriaHub's own page, not the packaged time zone UI: the
 * package keeps the zone on `profile.timezone`, while this app stores it at
 * the top level and keeps "never chose" (absent) distinct from an explicit
 * `'UTC'`.
 */
import { TimezoneSettings } from '../../components/settings/TimezoneSettings';
import { UserSettingsCardPage, errorMessage } from './UserSettingsCardPage';

export default function TimeZoneSettingsPage() {
  return (
    <UserSettingsCardPage
      title="Time zone"
      description="The time zone used to show dates and times."
    >
      {({ settings, isSaving, updateTimezone, notifySaved, notifyError }) => (
        <TimezoneSettings
          currentTimezone={settings.timezone}
          onTimezoneChange={async (timezone) => {
            try {
              await updateTimezone(timezone);
              notifySaved('Time zone updated');
            } catch (err) {
              notifyError(errorMessage(err, 'Failed to update time zone'));
            }
          }}
          disabled={isSaving}
        />
      )}
    </UserSettingsCardPage>
  );
}
