/**
 * The native `Notification` Web API — the toast this app raises for a
 * notification that arrived over the live stream.
 *
 * Issue #485, epic #481 (ported from EnterpriseAppBase).
 *
 * =============================================================================
 * THIS IS DECORATION. THE NOTIFICATION CENTRE IS THE FEATURE.
 * =============================================================================
 *
 * Everything here can fail, be blocked, or be unavailable, and the product must
 * be unaffected: permission is denied by many users, the API does not exist in
 * a non-secure context or under jsdom, and some hardened browsers define
 * `Notification` and throw on touching it. So every function here DEGRADES
 * SILENTLY and none of them throws.
 *
 * `requestBrowserNotificationPermission` (issue #486) is the ONLY place this
 * app asks for permission; observing it is
 * `hooks/useBrowserNotificationPermission.ts`'s job. The durable surface is the bell and
 * `/notifications`, which work with permission denied and the stream down.
 */

import type { NotificationItem } from '../types/notifications';

/**
 * Dispatched on `window` after every permission request settles, so every
 * mounted `useBrowserNotificationPermission` re-reads at once — the app-wide
 * banner and the settings page stay in agreement whichever of them (or the
 * auto-prompt) asked. Browsers without a Permissions API `change` event for
 * notifications would otherwise wait for the next `visibilitychange`.
 */
export const NOTIFICATION_PERMISSION_CHANGED_EVENT = 'app:notification-permission-changed';

function announcePermissionChanged(): void {
  try {
    window.dispatchEvent(new Event(NOTIFICATION_PERMISSION_CHANGED_EVENT));
  } catch {
    // Nothing listening can be helped by a throw here.
  }
}

/** Same icons the service worker's `push` handler uses (`sw.ts`). */
const TOAST_ICON = '/icons/icon-192.png';
const TOAST_BADGE = '/icons/badge-72.png';

/** Is the constructor there at all, and safe to touch? */
function isSupported(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    // The ACCESS is the test, not the presence of the key. Some embedded and
    // privacy-hardened browsers expose `Notification` and throw on reading
    // `permission` — the same defence `useBrowserNotificationPermission` takes,
    // for the same reason.
    void window.Notification.permission;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the browser for permission.
 *
 * =============================================================================
 * WHO CALLS THIS (issue #486)
 * =============================================================================
 *
 * Always through `requestPermissionAndSyncPush` (`services/pushSubscription.ts`),
 * from three places:
 *
 *   * THE AUTO-PROMPT — `hooks/usePushSubscriptionSync.ts`, once per page load,
 *     only when the deployment has push enabled and the device is `default`:
 *     push is worthless without permission, so the shell asks up front.
 *   * The app-wide `NotificationPermissionBanner`'s "Enable notifications"
 *     button.
 *   * The "Allow notifications" button in the Notifications card on
 *     `/settings`.
 *
 * The one exception is the admin push diagnostics (`services/pushDiagnostics.ts`,
 * `components/admin/PushTestPanel.tsx`), which call this directly: they walk
 * the push chain step by step and do their own subscription handling.
 *
 * The buttons still matter after the auto-prompt: Firefox ignores a request
 * with no user gesture, Safari may throw, and Chrome can demote it to a quiet
 * UI. A denial remains effectively permanent — only the user can undo it in
 * site settings — so nothing may call this in a loop or on every render.
 *
 * @returns the resulting permission, or `null` when the browser has no usable
 *          `Notification` API. The caller should refresh its permission state
 *          from `useBrowserNotificationPermission().refresh()` regardless of
 *          what comes back — that hook is the single source of truth for what
 *          the UI renders, and this return value is only what one call happened
 *          to see.
 */
export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | null
> {
  if (!isSupported()) return null;

  try {
    // `Notification.requestPermission()` has two signatures across browsers —
    // a promise (modern, everywhere current) and a legacy callback (old Safari).
    // `await` handles the promise form and, on the callback form, simply
    // resolves the `undefined` it returns; the UI is refreshed from
    // `Notification.permission` afterwards either way, so the legacy path
    // degrades to "the banner updates on the next visibility change" rather
    // than to a broken button.
    const result = await window.Notification.requestPermission();
    return result ?? window.Notification.permission;
  } catch {
    // A throw here is a browser that refuses the request outright. Not an error
    // worth surfacing: the permission state is unchanged, and the banner that
    // prompted the click already explains what is going on.
    return null;
  } finally {
    announcePermissionChanged();
  }
}

/**
 * Try the page-`Notification` constructor path — the ONLY path that existed
 * originally, and now the FALLBACK for browsers that either have no service
 * worker registration or where the SW call itself failed.
 *
 * Kept as its own function rather than inlined into `showAppNotification`
 * because it is also the emergency exit when the SW attempt throws for a
 * reason that has nothing to do with Android's SW-only restriction (a
 * misbehaving embedded browser, a registration stuck mid-update, etc) — one
 * `try` around one call, reused from two call sites instead of duplicated.
 *
 * @param onClick invoked when the user activates the toast. The window is
 *        focused first, because a toast is clicked from outside the browser and
 *        navigating a background tab the user cannot see is not a useful
 *        outcome. THIS FOCUS/ONCLICK WIRING HAS NO EQUIVALENT ON THE SW PATH —
 *        `ServiceWorkerRegistration.showNotification()` returns no handle to
 *        attach a JS `onclick` to; a clicked SW toast instead fires a
 *        `notificationclick` event inside the worker (`sw.ts`), which posts
 *        `{ type: 'notification-click', id, link, circleId }` back to an open
 *        tab (handled by `useNotificationClickHandling`) or opens one.
 * @returns whether a toast was actually raised this way.
 */
function showPageNotification(
  notification: NotificationItem,
  onClick?: (notification: NotificationItem) => void,
): boolean {
  try {
    const toast = new window.Notification(notification.title, {
      body: notification.body ?? '',

      // `tag` COLLAPSES DUPLICATES. The API publishes to every connection the
      // user has open, so someone with four tabs receives four copies of the
      // same event and would otherwise get four identical OS toasts. Tagging by
      // the notification's id makes the browser replace rather than stack them,
      // which is the only mechanism available — the tabs cannot coordinate, and
      // adding cross-tab leader election for a toast would be far more machinery
      // than the problem deserves.
      tag: notification.id,

      // NOT `renotify`. With the tag above, re-notifying would restore exactly
      // the duplicate alerting the tag exists to suppress.
    });

    if (onClick) {
      toast.onclick = () => {
        try {
          // The user clicked something outside the browser; without this the
          // navigation happens in a window they still cannot see.
          window.focus();
          onClick(notification);
        } finally {
          // Dismiss it ourselves. Platform behaviour on click varies — some
          // leave the toast sitting in a notification centre — and a toast that
          // outlives the click that handled it invites a second one.
          toast.close();
        }
      };
    }

    return true;
  } catch {
    // Constructing a `Notification` throws on Android Chrome, where the API is
    // service-worker-only. That is a supported outcome, not a bug: the
    // notification is already in the centre and the bell already shows it.
    return false;
  }
}

/**
 * Raise a native toast for a notification that just arrived over SSE.
 *
 * SILENT NO-OP unless permission is ALREADY `granted`. It never requests —
 * requesting from an incoming event would fire a prompt with no user gesture,
 * which browsers penalise or ignore.
 *
 * =============================================================================
 * WHY THE SERVICE-WORKER PATH IS TRIED FIRST
 * =============================================================================
 *
 * `new Notification(...)` THROWS ON ANDROID CHROME. The page constructor is
 * disabled there on purpose — Android requires every web notification to go
 * through a service worker registration's `showNotification()`, full stop.
 * Trying the page constructor FIRST and falling back to the SW would
 * "work" on every desktop browser and never once fire on Android, so the
 * order here is not a preference, it is the fix.
 *
 * =============================================================================
 * WHY `getRegistration()` AND NOT `navigator.serviceWorker.ready`
 * =============================================================================
 *
 * `.ready` is a promise that resolves once a service worker controls the
 * page — and NEVER RESOLVES AT ALL if that never happens. This app's SW
 * self-registers via `vite-plugin-pwa`'s auto-injected register script (see
 * `vite.config.ts`'s `injectRegister: 'auto'`), but nothing here guarantees
 * that registration has completed, or ever will (registration can fail, be
 * disabled by the browser, or simply not have run yet on this page load).
 * Awaiting `.ready` in that situation would hang this function's `await`
 * forever, and a notification path that can hang forever is worse than one
 * that occasionally falls back to the page path. `getRegistration()` instead
 * resolves immediately either way — with a registration, or with
 * `undefined` — which is the only shape compatible with "never throws, never
 * hangs".
 *
 * =============================================================================
 * WHY THE PAGE PATH STAYS, AS A FALLBACK
 * =============================================================================
 *
 * Desktop Safari has no bar against `new Notification(...)` and this app does
 * not currently register a service worker there in every configuration; more
 * generally, any browser where SW registration failed, is still in flight, or
 * was rejected by the user's settings still deserves a toast if permission is
 * independently `granted`. Falling back — rather than requiring a SW — keeps
 * every browser with a granted permission able to show something.
 *
 * @param onClick invoked when the user activates the toast — see
 *        `showPageNotification` above for why this ONLY fires on the page
 *        path, never on the SW path.
 * @returns which path actually raised the toast (`'sw'` or `'page'`), or
 *          `'none'` if neither did — including when the SW path found this
 *          exact tag already showing (cross-tab dedup) and deliberately
 *          skipped raising a second one. For tests and diagnostics; no caller
 *          makes a decision from it, because there is no fallback to fall
 *          back to — the notification is already in the centre.
 */
export async function showAppNotification(
  notification: NotificationItem,
  onClick?: (notification: NotificationItem) => void,
): Promise<'sw' | 'page' | 'none'> {
  try {
    if (!isSupported()) return 'none';
    if (window.Notification.permission !== 'granted') return 'none';

    if ('serviceWorker' in navigator) {
      try {
        // NOT `.ready` — see the doc comment above for why that can hang
        // forever. `getRegistration()` resolves immediately with `undefined`
        // when there is none.
        const registration = await navigator.serviceWorker.getRegistration();

        // Defensive: some unusual embedded WebViews expose `serviceWorker`
        // and return a registration-shaped object without a working
        // `showNotification` method. Checking the method itself, rather than
        // trusting the type, is the same posture `isSupported()` above takes
        // with `Notification.permission`.
        if (registration && typeof registration.showNotification === 'function') {
          // =====================================================================
          // CROSS-TAB DEDUP, REGISTRATION-WIDE
          // =====================================================================
          //
          // The API publishes to every open connection, so a user with four tabs
          // on this origin receives four `notification` stream frames for the
          // same event — one per tab — and without this check each tab would
          // independently reach this line and raise its own OS toast: four
          // popups for one notification.
          //
          // `getNotifications({ tag })` reads the OS notification tray through
          // the SERVICE WORKER REGISTRATION, which is shared by every tab of
          // this origin, not the calling tab's own state. So this is not "have
          // I shown this before" (which would need per-tab memory this module
          // deliberately doesn't keep) — it's "does a toast with this tag exist
          // anywhere right now, raised by any tab, including one that is racing
          // this one this very instant". `tag` is already the notification's id
          // (set below, and on the page path in `showPageNotification`), so an
          // existing entry can ONLY be this exact notification.
          //
          // This is why it beats the alternative the issue's write-up considered
          // and rejected — cross-tab leader election: that needs a coordination
          // protocol (BroadcastChannel, localStorage locks, a chosen leader tab)
          // that itself has failure modes (the leader tab closes mid-election,
          // two tabs both think they won a race). Reading the registration's own
          // notification list has none of that: there is nothing to coordinate,
          // because the browser already maintains one shared list per
          // registration and `tag` already collapses entries within it.
          //
          // Defensive `typeof` check for the same reason `showNotification`
          // above gets one: some embedded WebViews expose a registration-shaped
          // object with gaps in its method set. A missing `getNotifications`
          // degrades to "no dedup this call", not a thrown error — silent
          // degradation is this file's whole contract (see the header comment).
          if (typeof registration.getNotifications === 'function') {
            const existing = await registration.getNotifications({ tag: notification.id });
            if (existing.length > 0) return 'none';
          }

          await registration.showNotification(notification.title, {
            body: notification.body ?? '',
            tag: notification.id,
            icon: TOAST_ICON,
            badge: TOAST_BADGE,
            // Read by the service worker's `notificationclick` handler, which
            // needs the id (to mark it read), the link (to navigate) and the
            // circle (to switch to it first) and has no other way to get them —
            // a SW toast carries no JS closure the way the page path's does.
            // Same shape as the `push` handler's `data` in `sw.ts`.
            data: {
              id: notification.id,
              link: notification.link ?? '/',
              type: notification.type,
              circleId: notification.circleId,
            },
          });
          return 'sw';
        }
      } catch {
        // Fall through to the page path below. A SW that exists but rejects
        // `showNotification` (e.g. mid-update, or a browser bug) is not a
        // reason to lose the toast entirely when the page path might still
        // work.
      }
    }

    return showPageNotification(notification, onClick) ? 'page' : 'none';
  } catch {
    // Belt-and-braces: this function must never throw, no matter what a
    // future edit above does.
    return 'none';
  }
}
