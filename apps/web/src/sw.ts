/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { isInternalLink } from './utils/internalLink';

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
// Web Push
// -----------------------------------------------------------------------------

/**
 * The Web Push message body the API sends (JSON, well under the 4KB payload
 * limit). Only `title` is strictly needed to render; every other field is
 * optional and validated before use, because a push payload is input from
 * outside this worker.
 */
interface PushNotificationPayload {
  /** The `notifications` row id — carried into `data` for mark-read on click. */
  id?: string;
  title?: string;
  body?: string;
  /** Root-relative in-app route to open on click (e.g. `/duplicates`). */
  link?: string;
  /** OS collapse key; defaults to `id` so re-pushes of one row replace, not stack. */
  tag?: string;
  /** The `NotificationType` (e.g. `review_queue_duplicates`). */
  type?: string;
  /** The circle the notification belongs to, so the page can switch to it before navigating. */
  circleId?: string | null;
  icon?: string;
  badge?: string;
  /** Set only by the admin "send test push" action. See `handleTestPush`. */
  test?: boolean;
}

/** Keep in step with `NOTIFICATION_ICON` / `NOTIFICATION_BADGE` in `pwa/manifest.ts` (asserted by test). */
const PUSH_ICON = '/icons/icon-192.png';
const PUSH_BADGE = '/icons/badge-72.png';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * =============================================================================
 * THE CRITICAL RULE
 * =============================================================================
 * If a push event's `waitUntil` promise settles WITHOUT `showNotification`
 * having been called, Chrome substitutes its own generic "This site has been
 * updated in the background" notification — and repeated violations can cost
 * the origin its push permission. So every path below, including the
 * JSON-parse-failure path, ends in an awaited `showNotification`.
 *
 * A push is shown EVEN WHEN A FOCUSED TAB EXISTS. Suppressing it for a focused
 * client (and posting the payload to the page instead) is exactly the "silent
 * push" Chrome penalises, and it leaves a focused user with no visible alert
 * unless the page raises its own. The in-app bell already updates on its own
 * poll; the OS notification is the alert.
 */
async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushNotificationPayload;
  try {
    if (!event.data) throw new Error('push event carried no data');
    const parsed: unknown = event.data.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('push payload is not an object');
    payload = parsed as PushNotificationPayload;
  } catch {
    // Nothing usable to render. Showing a plain, generic notification is the
    // honest failure mode — doing nothing would surface Chrome's substitute.
    await self.registration.showNotification('New notification', {
      body: 'You have a new notification',
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      tag: 'push-fallback',
    });
    return;
  }

  if (payload.test === true) {
    await handleTestPush(payload);
    return;
  }

  const id = str(payload.id) ?? '';
  await self.registration.showNotification(str(payload.title) ?? 'New notification', {
    body: str(payload.body) ?? '',
    tag: str(payload.tag) ?? (id || undefined),
    // Icons are fetched by the OS, not by this worker; still, only same-origin
    // paths are honoured so a payload cannot point the notification at an
    // arbitrary tracking URL.
    icon: isInternalLink(payload.icon) ? payload.icon : PUSH_ICON,
    badge: isInternalLink(payload.badge) ? payload.badge : PUSH_BADGE,
    // Consumed by `notificationclick` below. `link` is passed through as-is;
    // validating it is that handler's job, at the point it navigates.
    data: {
      id,
      link: str(payload.link) ?? '/',
      type: str(payload.type) ?? null,
      circleId: str(payload.circleId) ?? null,
    },
  });
}

/**
 * A TEST PUSH (the admin "send test push" diagnostic). Shown like any other
 * push — always, even with a focused tab — and then ACKED to every window
 * client as `push-test-received`, so the diagnostics UI can prove end-to-end
 * delivery and measure latency. `data.id` is `''` on purpose: a test push
 * names no `notifications` row, so a click must not try to mark one read.
 *
 * Still obeys the critical rule: `showNotification` is attempted first, and a
 * failure is reported in the ack rather than rethrown.
 */
async function handleTestPush(payload: PushNotificationPayload): Promise<void> {
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const hadFocusedClient = windowClients.some(
    (client) => client.visibilityState === 'visible' && client.focused,
  );

  const id = str(payload.id) ?? '';
  let shown = false;
  let error: string | undefined;
  try {
    await self.registration.showNotification(str(payload.title) ?? 'Test notification', {
      body: str(payload.body) ?? '',
      tag: id || 'push-test',
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      data: { id: '', link: str(payload.link) ?? '/', type: null, circleId: null, test: true },
    });
    shown = true;
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const ack = {
    type: 'push-test-received',
    id,
    receivedAt: Date.now(),
    shown,
    hadFocusedClient,
    ...(error ? { error } : {}),
  };
  for (const client of windowClients) {
    try {
      client.postMessage(ack);
    } catch {
      // One client refusing the message must not stop the others hearing it.
    }
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

// -----------------------------------------------------------------------------
// notificationclick
// -----------------------------------------------------------------------------
// The ONLY place a click on a worker-shown notification can be handled — the
// click may arrive with no page open at all. Marking the notification read
// needs a token only a page holds (see the header), so this handler only ever
// DELIVERS the click to a page:
//   * a page is open — focus it and post `{ type: 'notification-click', id,
//     link, circleId }`; the page marks it read, switches circle and navigates
//     on its own token;
//   * no page is open — `clients.openWindow()` a fresh one at the link with
//     the id riding along as `?n=<id>`, for the booting app to mark read and
//     strip.
//
// `link` is RE-VALIDATED here even though the API writes only root-relative
// links: this handler feeds it into a real navigation, and anything that is
// not a single-leading-slash path falls back to `/`. A wrong destination
// inside the app is a wrong click; an accepted off-origin link is an open
// redirect.
self.addEventListener('notificationclick', (event) => {
  // Close first, so the OS cannot deliver a second click for the same
  // notification while the async work below is in flight.
  event.notification.close();

  const data = (event.notification.data ?? {}) as {
    id?: unknown;
    link?: unknown;
    circleId?: unknown;
  };
  const id = typeof data.id === 'string' ? data.id : '';
  const link = isInternalLink(data.link) ? data.link : '/';
  const circleId = typeof data.circleId === 'string' ? data.circleId : null;

  event.waitUntil(
    (async () => {
      // `includeUncontrolled: true`: a tab that was already open when this
      // worker installed is not retroactively controlled, and without the flag
      // the click would look like a cold open and launch a SECOND tab.
      const allClients = (await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })) as WindowClient[];

      if (allClients.length > 0) {
        // Prefer a window already on the link's path; else the first one.
        const linkPath = link.split('?')[0];
        const target =
          allClients.find((client) => {
            try {
              return new URL(client.url).pathname === linkPath;
            } catch {
              return false;
            }
          }) ?? allClients[0];

        await target.focus();
        target.postMessage({ type: 'notification-click', id, link, circleId });
        return;
      }

      // COLD OPEN: no page to post to, so the id rides along in the URL.
      const separator = link.includes('?') ? '&' : '?';
      await self.clients.openWindow(`${link}${separator}n=${encodeURIComponent(id)}`);
    })(),
  );
});

// -----------------------------------------------------------------------------
// pushsubscriptionchange
// -----------------------------------------------------------------------------

/**
 * `oldSubscription` is in the Push API spec but missing from TypeScript's
 * `lib.webworker.d.ts`. Augmented locally rather than suppressed, so a future
 * lib that adds it shows up as an honest type change here.
 */
interface PushSubscriptionChangeEventWithOldSubscription extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
}

/**
 * Best-effort resubscription with the OLD subscription's options. This worker
 * deliberately does NOT post the new subscription to the API (it has no token
 * — see the header). Instead it tells any open page, which re-syncs its
 * subscription with the server on its own token; a page that is not open does
 * the same idempotent re-sync on its next boot, which is the real mechanism.
 */
async function handlePushSubscriptionChange(
  event: PushSubscriptionChangeEvent,
): Promise<void> {
  const applicationServerKey = (event as PushSubscriptionChangeEventWithOldSubscription)
    .oldSubscription?.options?.applicationServerKey;

  let resubscribed = false;
  if (applicationServerKey) {
    try {
      await self.registration.pushManager.subscribe({
        applicationServerKey,
        userVisibleOnly: true,
      });
      resubscribed = true;
    } catch (error) {
      // Tolerated: the page's own re-sync recovers it.
      console.warn('Service worker push resubscription failed; page will resync.', error);
    }
  }

  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windowClients) {
    try {
      client.postMessage({ type: 'push-subscription-change', resubscribed });
    } catch {
      // Best-effort, like everything in this handler.
    }
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(handlePushSubscriptionChange(event));
});
