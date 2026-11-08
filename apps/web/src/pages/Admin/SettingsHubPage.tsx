/**
 * Admin → Settings (`/admin/settings`) — the Console hub.
 *
 * Since RETRO-B5 (#621) a binding over the packaged `SettingsHub`
 * (`@marinoscar/platform-web/settings/ui`), the same component `/settings`
 * renders. All of the behaviour — the card grid, the drill-down list below
 * `sm`, the search field, the empty state — is the package's; this file
 * contributes the registry, its scroll key, its prose and the three app seams
 * the package takes as props (the permission check, the feature map and the
 * scroll restoration). It must never grow admin-specific rendering, and the hub
 * must never be forked.
 *
 * The hub's `down('sm')` compact gate is breakpoint gate 4 of the five coupled
 * gates (see `components/common/Layout.tsx`); it moved into the package
 * unchanged and must keep agreeing with `AppBar`'s `isCompactWindow`.
 */

import { Navigate } from 'react-router-dom';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { SettingsHub } from '@marinoscar/platform-web/settings/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { ADMIN_HUB_TITLE, ADMIN_SECTIONS } from '../../config/adminSections';

export default function SettingsHubPage() {
  const { isAdmin, hasPermission } = usePermissions();
  const features = useSettingsFeatures();

  // Unchanged from the app-local hub: the Console is an admin surface. The
  // cards are still gated one by one (`visibleSettingsSections`), and the API
  // enforces every permission regardless.
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <SettingsHub
      sections={ADMIN_SECTIONS}
      // Namespaced per surface: `/settings`'s hub is a different document of a
      // different height, and a shared key would restore one page's offset
      // onto the other.
      hubKey="admin-settings-hub"
      title={ADMIN_HUB_TITLE}
      subtitle="Manage system configuration, providers, and operational settings."
      hasPermission={hasPermission}
      features={features}
      useScrollRestoration={useScrollRestoration}
    />
  );
}
