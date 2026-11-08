// =============================================================================
// The Alerts admin page (RETRO-H5, #609)
// =============================================================================
//
// The packaged `AlertsPage` of `@marinoscar/platform-web/alerts/ui` (Rules and
// Incidents tabs, the rule editor, the dry run, the incident drawer) on
// `/api/admin/alerts`. A default export so `App.tsx` can lazy-load it into its
// own chunk; the card is the slice's `alertsAdminCards` (`config/adminSections.tsx`).
//
// The route is guarded on `alerts:read` (the string every read route of the
// alerts controller enforces); the page itself draws its write controls only
// for a holder of `alerts:write`.
// =============================================================================

import { AlertsPage } from '@marinoscar/platform-web/alerts/ui';

export default function AlertsAdminPage() {
  return <AlertsPage />;
}
