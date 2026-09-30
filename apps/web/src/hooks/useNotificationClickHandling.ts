/**
 * What happens when the user opens a notification from OUTSIDE the bell —
 * issue #486, epic #481.
 *
 * MOUNTED ONCE, in `components/common/Layout.tsx` (authenticated shell only).
 * Three entry points, one behaviour — mark the row read, switch to its circle
 * if it belongs to another one, then navigate to its link:
 *
 *   1. A click on an OS toast raised by the SERVICE WORKER (a Web Push, or a
 *      stream toast raised via `registration.showNotification`). `sw.ts`
 *      focuses an open tab and posts `{ type: 'notification-click', id, link,
 *      circleId }` to it.
 *   2. A click on a toast raised by the PAGE fallback (`new Notification`),
 *      routed here through `setNotificationOpenHandler`.
 *   3. A COLD OPEN: no tab was open, so the worker opened
 *      `${link}?n=<id>&c=<circleId>` (`c` only when the row has a circle).
 *      The id is marked read, the active circle switched to `c`, and both
 *      params stripped (replace, not push). The window is already AT the link,
 *      so there is nothing left to navigate to — only the circle to fix.
 *
 * CIRCLE BEFORE NAVIGATE. Review-queue links (`/bursts`, `/duplicates`, …) are
 * circle-agnostic routes that render the ACTIVE circle, so the circle must be
 * switched first — the same rule, and the same stale-circle guard, as
 * `NotificationPanel.handleOpenNotification`. Links are re-validated as
 * root-relative (`isInternalLink`) because a posted message is still input.
 */

import { useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCircle } from './useCircle';
import {
  markNotificationReadById,
  setNotificationOpenHandler,
} from './useNotifications';
import { isInternalLink } from '../utils/internalLink';

/** The message `sw.ts` posts to a focused tab on `notificationclick`. */
export const NOTIFICATION_CLICK_MESSAGE = 'notification-click';

/** Query param a cold-opened window carries the clicked notification id in. */
export const NOTIFICATION_ID_PARAM = 'n';

/** Query param a cold-opened window carries the notification's circle id in. */
export const NOTIFICATION_CIRCLE_PARAM = 'c';

export interface NotificationTarget {
  circleId: string | null;
  link: string | null;
}

/**
 * Switch to the target's circle (when known and different), then navigate to
 * its link. Returns a stable callback.
 */
export function useOpenNotificationTarget(): (target: NotificationTarget) => void {
  const navigate = useNavigate();
  const { circles, activeCircleId, setActiveCircle } = useCircle();

  return useCallback(
    (target: NotificationTarget) => {
      // `circles.length === 0` means "not loaded yet", never "member of
      // nothing" — every user has a personal circle. A circle the user no
      // longer belongs to is NOT switched to (it would strand the app with no
      // resolvable active circle).
      const circleKnown =
        circles.length === 0 || circles.some((c) => c.id === target.circleId);
      if (target.circleId && target.circleId !== activeCircleId && circleKnown) {
        void setActiveCircle(target.circleId);
      }
      if (isInternalLink(target.link)) navigate(target.link);
    },
    [circles, activeCircleId, setActiveCircle, navigate],
  );
}

export function useNotificationClickHandling(): void {
  const openTarget = useOpenNotificationTarget();
  const [searchParams, setSearchParams] = useSearchParams();

  // 2. Page-raised toast clicks (the store marks the row read itself).
  useEffect(() => setNotificationOpenHandler(openTarget), [openTarget]);

  // 1. Service-worker toast clicks.
  useEffect(() => {
    let container: ServiceWorkerContainer | undefined;
    try {
      container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    } catch {
      container = undefined;
    }
    if (!container || typeof container.addEventListener !== 'function') return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: unknown; id?: unknown; link?: unknown; circleId?: unknown }
        | null;
      if (!data || data.type !== NOTIFICATION_CLICK_MESSAGE) return;

      // An empty id is a test push (`push-test-received` flow) — nothing to mark.
      if (typeof data.id === 'string' && data.id) void markNotificationReadById(data.id);
      openTarget({
        circleId: typeof data.circleId === 'string' ? data.circleId : null,
        link: isInternalLink(data.link) ? data.link : null,
      });
    };

    container.addEventListener('message', onMessage);
    return () => {
      try {
        container?.removeEventListener('message', onMessage);
      } catch {
        // Best-effort teardown.
      }
    };
  }, [openTarget]);

  // 3. Cold open via `?n=<id>&c=<circleId>`. The window is already on the
  // link, so `openTarget` is called with no link: it only switches circle
  // (with the same stale-circle guard as every other entry point).
  const clickedId = searchParams.get(NOTIFICATION_ID_PARAM);
  const clickedCircleId = searchParams.get(NOTIFICATION_CIRCLE_PARAM);
  useEffect(() => {
    if (clickedId === null && clickedCircleId === null) return;
    if (clickedId) void markNotificationReadById(clickedId);
    if (clickedCircleId) openTarget({ circleId: clickedCircleId, link: null });
    const next = new URLSearchParams(searchParams);
    next.delete(NOTIFICATION_ID_PARAM);
    next.delete(NOTIFICATION_CIRCLE_PARAM);
    setSearchParams(next, { replace: true });
  }, [clickedId, clickedCircleId, searchParams, setSearchParams, openTarget]);
}
