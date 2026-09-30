/**
 * Keep this device's Web Push subscription alive — issue #486, epic #481
 * (ported from EnterpriseAppBase).
 *
 * MOUNTED ONCE, in `components/common/Layout.tsx`, which only renders for an
 * authenticated user. It owns three automatic behaviours and one action:
 *
 *   1. THE AUTO-PROMPT. When the deployment offers push (and has not switched
 *      browser notifications off) and this device has never been asked, the
 *      permission prompt is requested as soon as the shell loads — at most once
 *      per page load (`claimAutoPermissionPrompt`). Firefox and Safari ignore a
 *      gestureless request and Chrome may quiet it, which is why the app-wide
 *      `NotificationPermissionBanner` still offers a button.
 *   2. THE BOOT SYNC. Whenever permission is `granted` and push is enabled,
 *      subscribe if needed and POST the subscription (an idempotent upsert).
 *      Runs on every load, again the moment permission becomes `granted`, and
 *      again when the VAPID key rotates (a new `vapidPublicKey`).
 *   3. THE WORKER'S NUDGE. The service worker's `pushsubscriptionchange`
 *      handler cannot report a replaced subscription itself (it holds no
 *      token), so it posts `{ type: 'push-subscription-change' }` to open
 *      pages; this hook re-syncs on that message with the page's own token.
 *   4. `requestPermission` — ask, then sync. The banner's button uses it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useIsMounted } from './useIsMounted';
import {
  useNotificationCapability,
  type NotificationCapability,
} from './useNotificationCapability';
import { useNotificationConfig } from './useNotificationConfig';
import {
  claimAutoPermissionPrompt,
  requestPermissionAndSyncPush,
  syncPushSubscription,
} from '../services/pushSubscription';
import type { NotificationClientConfig } from '../types/notifications';

/** The service worker's message after `pushsubscriptionchange` (`sw.ts`). */
export const PUSH_SUBSCRIPTION_CHANGE_MESSAGE = 'push-subscription-change';

export interface UsePushSubscriptionSyncResult {
  /** `null` until `GET /api/notifications/config` resolves. */
  config: NotificationClientConfig | null;
  capability: NotificationCapability;
  /** Ask for permission (from a click), then subscribe and sync if granted. */
  requestPermission: () => Promise<void>;
  isRequestingPermission: boolean;
}

export function usePushSubscriptionSync(): UsePushSubscriptionSyncResult {
  const { config } = useNotificationConfig();
  // `=== false`, never `!browserEnabled`: a `null` config is "not known yet".
  const { capability, permission, refresh } = useNotificationCapability({
    adminDisabled: config?.browserEnabled === false,
  });

  const isMounted = useIsMounted();
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  const requestPermission = useCallback(async () => {
    setIsRequestingPermission(true);
    try {
      await requestPermissionAndSyncPush(config);
    } finally {
      if (isMounted()) {
        setIsRequestingPermission(false);
        refresh();
      }
    }
  }, [config, isMounted, refresh]);

  // 1. The auto-prompt. `capability === 'default'` already excludes every
  //    state where asking is impossible or pointless (admin-disabled,
  //    insecure, unsupported, iOS tab, denied, granted).
  useEffect(() => {
    if (!config?.pushEnabled || config.browserEnabled === false) return;
    if (capability !== 'default') return;
    if (!claimAutoPermissionPrompt()) return;
    void requestPermission();
  }, [config, capability, requestPermission]);

  // 2. The boot sync. Keyed on the primitives, so a config refetch returning
  //    the same values does not re-POST; a rotated key does.
  const vapidPublicKey = config?.pushEnabled ? config.vapidPublicKey : null;
  useEffect(() => {
    if (permission !== 'granted' || !vapidPublicKey) return;
    void syncPushSubscription(vapidPublicKey);
  }, [permission, vapidPublicKey]);

  // 3. The service worker replaced the subscription — report it.
  useEffect(() => {
    if (permission !== 'granted' || !vapidPublicKey) return;
    let container: ServiceWorkerContainer | undefined;
    try {
      container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    } catch {
      container = undefined;
    }
    if (!container || typeof container.addEventListener !== 'function') return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type !== PUSH_SUBSCRIPTION_CHANGE_MESSAGE) return;
      void syncPushSubscription(vapidPublicKey);
    };
    container.addEventListener('message', onMessage);
    return () => {
      try {
        container?.removeEventListener('message', onMessage);
      } catch {
        // Best-effort teardown.
      }
    };
  }, [permission, vapidPublicKey]);

  return { config, capability, requestPermission, isRequestingPermission };
}
