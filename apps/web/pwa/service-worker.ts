import type { VitePWAOptions } from 'vite-plugin-pwa';
import { buildManifest } from './manifest';

// =============================================================================
// vite-plugin-pwa options  (issue #482, epic #481)
// =============================================================================
//
// Config-side code, like `pwa/manifest.ts`: `vite.config.ts` imports it, the
// React tree never does, and returning the options from a function gives
// `src/__tests__/pwa/service-worker.test.ts` one thing to call so the
// invariants below are ASSERTED rather than merely commented.
//
// This module names `src/sw.ts` as a string (`srcDir` + `filename`) and must
// never import it: `sw.ts` is compiled against `tsconfig.worker.json` (no DOM
// lib) and runs workbox side effects at import time.
//
// WHY `injectManifest` AND NOT `generateSW`
//
// `generateSW` writes the whole worker from config, leaving nowhere to put the
// `push`, `notificationclick` and `pushsubscriptionchange` handlers — and on
// Android Chrome a worker-hosted `showNotification()` is the ONLY way a
// notification can be shown (`new Notification()` throws there). Its
// `importScripts` escape hatch splits one worker across a generated file and a
// hand-written one that cannot see each other. `injectManifest` keeps one
// reviewable worker (`src/sw.ts`) and only substitutes the precache list in.
// =============================================================================

/**
 * Builds the `vite-plugin-pwa` options for the application build.
 *
 * `registerType: 'prompt'`: a new worker installs and then WAITS rather than
 * activating under a user mid-session, whose loaded page would otherwise start
 * requesting chunk filenames the new revision has rotated away (and whose
 * unsaved edits an auto-reload would discard). The page hands over by posting
 * `SKIP_WAITING`, from `src/components/pwa/UpdatePrompt.tsx`.
 *
 * `injectRegister: null`: the React tree owns registration (`useRegisterSW` in
 * `UpdatePrompt.tsx`). With `'auto'` the plugin would ALSO inject a
 * `registerSW.js`, registering the worker a second time from a script the
 * hook cannot observe.
 */
export function buildServiceWorkerOptions(): Partial<VitePWAOptions> {
  return {
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: null,
    manifest: buildManifest(),
    injectManifest: {
      // The app shell, and only the app shell. Every pattern is matched against
      // `dist/`, which is built entirely from `apps/web` and contains nothing
      // from the API (a separate service nginx mounts at `/api`). Cache Storage
      // is origin-scoped and survives logout, so an authenticated `/api`
      // response cached here would be readable by the next person to sign in
      // on a shared device. Do not add `json` or anything API-shaped.
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    },
    devOptions: {
      // Exercise the worker against `npm run dev`; otherwise the only way to
      // learn whether `sw.ts` even parses is a production build.
      enabled: true,
      // ESM in dev: the un-bundled worker keeps its `workbox-*` imports, which
      // a classic worker cannot load.
      type: 'module',
      // In dev the injection point becomes `[{ url: 'index.html' }]`; without
      // this it is `[]`, and `createHandlerBoundToURL('/index.html')` throws
      // `non-precached-url` on activation — in dev only.
      navigateFallback: 'index.html',
    },
  };
}
