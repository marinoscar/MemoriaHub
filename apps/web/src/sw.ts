/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { registerNotificationServiceWorkerHandlers } from '@marinoscar/platform-web/notifications/service-worker';

// =============================================================================
// The service worker  (issue #482, epic #481)
// =============================================================================
//
// WHY THIS FILE EXISTS
//
// Not for offline support — that is the bonus. On ANDROID CHROME the
// Notifications API is service-worker-only: `new Notification()` throws
// (`Illegal constructor`), and `ServiceWorkerRegistration.showNotification()`
// is the single code path that can put a notification on the screen. It is
// also the only place Web Push's `push`, `notificationclick` and
// `pushsubscriptionchange` handlers can live — a page cannot host them.
//
// -----------------------------------------------------------------------------
// HARD CONSTRAINT: THIS WORKER MUST NEVER CALL THE API
// -----------------------------------------------------------------------------
//
// It has no way to authenticate, and any attempt to acquire one breaks the
// page. The access token is MEMORY-ONLY (a private field of the page's
// `ApiClient`), and the HttpOnly `refresh_token` cookie is ROTATED ON EVERY
// USE — a worker that refreshed on its own would spend the one-shot refresh
// token behind the page's back, and the user would be logged out by their own
// service worker. Anything the worker needs from the API is pushed TO it (a
// Web Push payload) and anything it learns is posted to an open page, which
// makes the API call on its own token. `service-worker.test.ts` greps this
// file for `fetch(` and `'/api/` to hold the line.
//
// -----------------------------------------------------------------------------
// SECURITY: NOTHING UNDER `/api` MAY EVER BE CACHED
// -----------------------------------------------------------------------------
//
// Cache Storage is origin-scoped, outlives the session, and is not partitioned
// per account, so a cached authenticated response would be readable by the
// next person to sign in on a shared device. There is deliberately no runtime
// caching strategy below, and `globPatterns` (`pwa/service-worker.ts`) only
// matches built static assets, which never include `/api`.
// =============================================================================

declare let self: ServiceWorkerGlobalScope;

// -----------------------------------------------------------------------------
// Precache the app shell
// -----------------------------------------------------------------------------
// `self.__WB_MANIFEST` is replaced at build time with the list of built
// assets. `cleanupOutdatedCaches()` deletes precaches from PREVIOUS revisions;
// without it every deploy grows Cache Storage by another copy of the bundle.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// -----------------------------------------------------------------------------
// SPA navigation fallback
// -----------------------------------------------------------------------------
// In-app routes (`/albums`, `/admin/settings/jobs`, …) have no file behind
// them, so a navigation is answered from the precached `index.html` — the job
// `try_files $uri $uri/ /index.html` does in `apps/web/nginx.conf`, offline.
//
// THE DENYLIST IS LOAD-BEARING. `/^\/api\//` keeps the worker out of the API's
// URL space entirely: `/api/docs` (Scalar) and the public-share byte proxy are
// real server responses that must never be swapped for the SPA shell, and a
// long-lived streaming response taken over by a worker handler would pin the
// worker awake until the browser killed it. Do not narrow it to individual
// paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

// -----------------------------------------------------------------------------
// Take control of open pages as soon as this worker activates
// -----------------------------------------------------------------------------
// On a FIRST load the page that installed the worker is not controlled by it,
// and without `clientsClaim()` a user who grants notification permission would
// see nothing on Android until they reload.
clientsClaim();

// -----------------------------------------------------------------------------
// Update handshake  (`registerType: 'prompt'`)
// -----------------------------------------------------------------------------
// Deliberately NO top-level `self.skipWaiting()`: a new worker installs and
// WAITS, so a user mid-session keeps the asset revisions their loaded page was
// built against. The page decides when to hand over by posting
// `{ type: 'SKIP_WAITING' }` (`components/pwa/UpdatePrompt.tsx`).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// -----------------------------------------------------------------------------
// Web Push  (the platform notifications slice since RETRO-D3, #576)
// -----------------------------------------------------------------------------
// `push`, `notificationclick` and `pushsubscriptionchange` are the packaged
// handlers (`@marinoscar/platform-web/notifications/service-worker`, React-free:
// never the `/headless` barrel here). They keep this file's rules: every push is
// SHOWN (even with a focused tab, so Chrome never substitutes its generic
// notification), the worker never calls the API (a click is handed to an open
// page, or opens the link with `?n=<id>` for the page to mark read), and a
// link is re-validated as root-relative before it is opened. A MemoriaHub link
// carries its circle as `?c=<circleId>`, which the page applies on arrival.
// The icon and badge stay in step with `NOTIFICATION_ICON` /
// `NOTIFICATION_BADGE` in `pwa/manifest.ts`.
registerNotificationServiceWorkerHandlers(self, {
  icon: '/icons/icon-192.png',
  badge: '/icons/badge-72.png',
});

