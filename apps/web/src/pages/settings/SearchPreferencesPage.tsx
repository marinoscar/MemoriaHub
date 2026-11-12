/** Settings → Search (`/settings/search`), RETRO-B5 #621: the search field preferences. */
import { SearchFieldsSettings } from '@marinoscar/memoriahub-web/search/ui';
import { UserSettingsCardPage } from './UserSettingsCardPage';

export default function SearchPreferencesPage() {
  return (
    <UserSettingsCardPage
      title="Search"
      description="Choose which fields the search panel offers."
    >
      {({ settings, isSaving, updateSettings }) => (
        <SearchFieldsSettings
          settings={settings}
          updateSettings={updateSettings}
          disabled={isSaving}
        />
      )}
    </UserSettingsCardPage>
  );
}
