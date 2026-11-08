/**
 * The deployment features a settings card may be gated on (RETRO-B5, #621).
 *
 * The packaged registry declares `ai` and `telemetry`; the identity slice's
 * organization cards carry `feature: 'orgs'`, so the key is declared here and
 * read the platform's way (`useOrgsFeature`: `/api/auth/me` reports
 * `tenancyMode: 'multi'`). MemoriaHub runs in single-organization mode, so the
 * feature is off and the organization cards stay out of the registry anyway.
 *
 * `telemetry` is the platform's own key (RETRO-T2, #625): a telemetry store is deployed AND
 * collection is on, read from the shell's one copy of `GET /api/telemetry/config`
 * (`platform/TelemetryConfigBinding.tsx`), never fetched here. The Telemetry Explorer and
 * Dashboard cards carry `feature: 'telemetry'`; the Telemetry settings card has none.
 *
 * Imported for its side effect by both registries, so the resolver is
 * registered before the first `useSettingsFeatures()` render.
 */
import { useOrgsFeature } from '@marinoscar/platform-web/identity/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import { useTelemetryFeatures } from '@marinoscar/platform-web/telemetry/headless';

declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    /** A multi-organization deployment (`TENANCY_MODE=multi`). */
    orgs: true;
  }
}

registerSettingsFeature('orgs', useOrgsFeature);
registerSettingsFeature('telemetry', () => useTelemetryFeatures().telemetry);
