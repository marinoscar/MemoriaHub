// =============================================================================
// The web app manifest  (issue #482, epic #481)
// =============================================================================
//
// WHY THIS FILE LIVES OUTSIDE `src/`
//
// It is CONFIG-SIDE code: `pwa/service-worker.ts` hands it to
// `VitePWA({ manifest })` in `vite.config.ts`, and the React tree never imports
// it. `tsconfig.node.json` owns it, alongside `vite.config.ts`.
//
// WHY IT REPLACES `public/site.webmanifest`
//
// Letting VitePWA emit `manifest.webmanifest` means the plugin also adds it to
// the precache and serves it in dev with the right Content-Type.
//
// WHY THE BRAND VALUES ARE RESTATED HERE RATHER THAN IMPORTED
//
// `tsconfig.node.json` is a COMPOSITE project referenced by `tsconfig.json`,
// and a file may not belong to both: importing `src/constants/app.ts` from
// here fails the typecheck with TS6305/TS6307. So the three values below are
// copies, and `src/__tests__/pwa/manifest.test.ts` asserts they equal
// `APP_NAME` (`src/constants/app.ts`) and the light palette's `primary.main`
// (`src/theme/light.ts`) — a rebrand that changes one side fails the suite
// instead of shipping an installed app labelled or coloured as the old one.
//
// WHAT MATTERS HERE AND IS NOT COSMETIC
//
//   - `display: 'standalone'` is what iOS/iPadOS 16.4+ reads before allowing
//     "Add to Home Screen" as a web app, and Safari grants the Notifications /
//     Push APIs ONLY to such an installed web app. Without it, Web Push is
//     unreachable on every iPhone and iPad.
//   - `id: '/'` pins the installed app's identity, so `start_url` can change
//     later without the OS treating the result as a second installation.
//   - The `monochrome` badge is what Android draws in the status bar for a
//     push notification. Android uses only its alpha channel, which is why it
//     is a white silhouette (`scripts/generate-pwa-icons.mjs`).
// =============================================================================

/** Must equal `APP_NAME` in `src/constants/app.ts` (asserted by test). */
export const MANIFEST_APP_NAME = 'MemoriaHub';
/** Must equal the light palette's `primary.main` and `index.html`'s theme-color (asserted by test). */
export const THEME_COLOR = '#1976d2';
/** The installed app's splash-screen ground. */
export const BACKGROUND_COLOR = '#ffffff';

/** A single entry in the manifest's `icons` array. */
export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable' | 'monochrome';
}

/** The web app manifest, as serialised into `manifest.webmanifest`. */
export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  orientation: 'any';
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

/** The icon a push notification shows, and the status-bar badge. `src/sw.ts` uses the same paths. */
export const NOTIFICATION_ICON = '/icons/icon-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-72.png';

/**
 * Builds the web app manifest. Every icon `src` points at a file committed
 * under `public/icons/`, which Vite copies into `dist/` verbatim;
 * `src/__tests__/pwa/manifest.test.ts` asserts each one exists on disk,
 * because Vite never validates manifest paths and a missing icon silently
 * breaks installability.
 */
export function buildManifest(): WebAppManifest {
  return {
    id: '/',
    name: MANIFEST_APP_NAME,
    short_name: MANIFEST_APP_NAME,
    description: `${MANIFEST_APP_NAME} — your personal media hub`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: NOTIFICATION_BADGE, sizes: '72x72', type: 'image/png', purpose: 'monochrome' },
    ],
  };
}
