/**
 * Admin → Settings → About (`/admin/settings/about`).
 *
 * The platform's page (RETRO-B1, #597): what is deployed here, from
 * `GET /api/admin/about`, including this app's own "Enrichment" group
 * contributed on the API through the About registry. A registry card in
 * `config/adminSections.tsx` and a route in `App.tsx` gated on the same
 * `system_settings:read` the API enforces; nothing else is this app's.
 */
export { AboutPage as default } from '@marinoscar/platform-web/host/ui';
