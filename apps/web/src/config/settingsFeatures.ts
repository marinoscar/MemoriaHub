/**
 * The deployment features a settings card may be gated on (RETRO-B5, #621).
 *
 * The packaged registry declares `ai` and `telemetry`; the identity slice's
 * organization cards carry `feature: 'orgs'`, so the key is declared here and
 * read the platform's way (`useOrgsFeature`: `/api/auth/me` reports
 * `tenancyMode: 'multi'`). MemoriaHub runs in single-organization mode, so the
 * feature is off and the organization cards stay out of the registry anyway.
 *
 * Imported for its side effect by both registries, so the resolver is
 * registered before the first `useSettingsFeatures()` render.
 */
import { useOrgsFeature } from '@marinoscar/platform-web/identity/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';

declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    /** A multi-organization deployment (`TENANCY_MODE=multi`). */
    orgs: true;
  }
}

registerSettingsFeature('orgs', useOrgsFeature);
