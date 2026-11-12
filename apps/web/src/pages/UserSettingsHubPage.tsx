/**
 * Settings (`/settings`) — the per-user hub.
 *
 * RETRO-B5 (#621): a binding over the packaged `SettingsHub`
 * (`@marinoscar/platform-web/settings/ui`), the twin of
 * `pages/Admin/SettingsHubPage.tsx`. This file contributes the registry, its
 * scroll key, its prose and the app seams the package takes as props. It must
 * never grow user-specific rendering, and the hub must never be forked.
 *
 * NO PERMISSION CHECK on the route: every signed-in user owns their settings;
 * the hub's `visibleSettingsSections` filters the one gated card.
 *
 * Old deep links into the stacked page (`/settings#notifications`,
 * `#search-fields`, `#android-app`) redirect to the card page that now holds
 * that section.
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { SettingsHub } from '@marinoscar/platform-web/settings/ui';
import { usePermissions } from '../hooks/usePermissions';
import { useScrollRestoration } from '../hooks/useScrollRestoration';
import { USER_HUB_TITLE, USER_SETTINGS_SECTIONS } from '../config/userSettingsSections';
import { ANDROID_APP_SETTINGS_PATH } from '@marinoscar/memoriahub-web/media-sync/headless';

/** The stacked page's section anchors and the card page each moved to. */
export const LEGACY_SETTINGS_ANCHORS: Readonly<Record<string, string>> = {
  notifications: '/settings/notifications',
  'search-fields': '/settings/search',
  'android-app': ANDROID_APP_SETTINGS_PATH,
};

export default function UserSettingsHubPage() {
  const { hasPermission } = usePermissions();
  const features = useSettingsFeatures();
  const { hash, search } = useLocation();

  const anchor = hash.startsWith('#') ? safeDecode(hash.slice(1)) : '';
  const target = Object.prototype.hasOwnProperty.call(LEGACY_SETTINGS_ANCHORS, anchor) ? LEGACY_SETTINGS_ANCHORS[anchor] : undefined;
  if (target) {
    return <Navigate to={`${target}${search}`} replace />;
  }

  return (
    <SettingsHub
      sections={USER_SETTINGS_SECTIONS}
      // NOT `admin-settings-hub`: the two hubs are different documents of
      // different heights; a shared key would restore one onto the other.
      hubKey="user-settings-hub"
      title={USER_HUB_TITLE}
      subtitle="Manage your account preferences"
      hasPermission={hasPermission}
      features={features}
      useScrollRestoration={useScrollRestoration}
    />
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
