/**
 * Web Push subscription state, page side (epic #481; ported from
 * EnterpriseAppBase).
 *
 * Issue #485 needs one question answered before the page raises its own toast
 * for a streamed notification: "will the service worker ALSO show this, because
 * it arrives over Web Push?" — `hasActivePushSubscription` below. Issue #486
 * adds the subscription lifecycle itself (subscribe, sync, remove).
 *
 * NOTHING HERE THROWS. Push is decoration over the notification centre.
 */

/**
 * VAPID public keys travel as URL-safe base64 without padding;
 * `pushManager.subscribe` wants the raw bytes.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function hasPushSupport(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof window !== 'undefined' &&
      'PushManager' in window
    );
  } catch {
    return false;
  }
}

/**
 * Does an existing subscription use `key`?
 *
 * Only a DEFINITE mismatch counts. A browser that does not expose
 * `options.applicationServerKey` returns `true` here: re-subscribing on every
 * boot would mint a new endpoint each time and orphan the previous row.
 */
function subscriptionUsesKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== key.length) return false;
  return bytes.every((byte, index) => byte === key[index]);
}

// =============================================================================
// "Will the service worker's push show this?" — issue #485
// =============================================================================

/**
 * How long a `hasActivePushSubscription` answer is reused. Long enough that a
 * burst of stream frames (a broadcast storm, a reconnect) costs one lookup,
 * short enough that a permission revoked in browser settings is noticed soon.
 */
export const ACTIVE_PUSH_SUBSCRIPTION_CACHE_MS = 30_000;

let activeSubscriptionCache: {
  key: string | null;
  expiresAt: number;
  result: Promise<boolean>;
} | null = null;

export function invalidateActivePushSubscriptionCache(): void {
  activeSubscriptionCache = null;
}

async function lookupActivePushSubscription(vapidPublicKey: string | null): Promise<boolean> {
  try {
    if (!vapidPublicKey) return false;
    if (!hasPushSupport()) return false;
    if (window.Notification?.permission !== 'granted') return false;

    // `getRegistration()`, NOT `.ready`: `.ready` never settles on a page with
    // no worker, and this answer sits in front of a toast.
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.pushManager) return false;

    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return false;

    return subscriptionUsesKey(subscription, urlBase64ToUint8Array(vapidPublicKey));
  } catch {
    return false;
  }
}

/**
 * Does this browser hold a live Web Push subscription for `vapidPublicKey`,
 * i.e. will the service worker be woken to show a push sent to this user?
 *
 * True only when push is supported, notification permission is `granted`, a
 * service worker is registered, it has a subscription, and that subscription
 * was made with this key (a browser that hides the subscription's key counts
 * as a match — see `subscriptionUsesKey`). NEVER THROWS: any failure is `false`,
 * which callers treat as "the page must show its own toast". Cached for
 * `ACTIVE_PUSH_SUBSCRIPTION_CACHE_MS` per key.
 */
export function hasActivePushSubscription(vapidPublicKey: string | null): Promise<boolean> {
  const now = Date.now();
  if (
    activeSubscriptionCache &&
    activeSubscriptionCache.key === vapidPublicKey &&
    activeSubscriptionCache.expiresAt > now
  ) {
    return activeSubscriptionCache.result;
  }
  const result = lookupActivePushSubscription(vapidPublicKey);
  activeSubscriptionCache = {
    key: vapidPublicKey,
    expiresAt: now + ACTIVE_PUSH_SUBSCRIPTION_CACHE_MS,
    result,
  };
  return result;
}

/** Test-only: forget module state between tests. */
export function resetPushSubscriptionStateForTests(): void {
  activeSubscriptionCache = null;
}
