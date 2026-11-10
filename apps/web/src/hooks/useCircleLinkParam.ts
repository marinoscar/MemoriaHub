/**
 * Switch the active circle from a link's `?c=<circleId>` (RETRO-D3, #576).
 *
 * MemoriaHub's notification links are circle-agnostic routes (`/bursts`,
 * `/duplicates`, `/`, ...) that render the ACTIVE circle, so a notification
 * about another circle must switch circle before the page shows. The event
 * templates (`apps/api/src/notifications-registry/memoriahub.notifications.ts`)
 * append `?c=<circleId>`, and the carry-over did the same for copied rows.
 * Every way a notification is opened (the bell, the inbox page, an OS toast,
 * a cold open from a Web Push) lands on that URL, so ONE hook, mounted once in
 * the shell layout, covers them all: it switches circle when the id is one the
 * user belongs to (never a stale one: that would strand the app with no
 * resolvable active circle) and strips the parameter (replace, not push).
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOwnerScope } from './useOwnerScope';

/** The query parameter a notification link carries its circle in. */
export const NOTIFICATION_CIRCLE_PARAM = 'c';

export function useCircleLinkParam(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const { circles, activeCircleId, setActiveCircle } = useOwnerScope();
  const circleId = searchParams.get(NOTIFICATION_CIRCLE_PARAM);

  useEffect(() => {
    if (circleId === null) return;
    // `circles.length === 0` means "not loaded yet": wait for the list.
    if (circles.length === 0) return;
    if (circleId && circleId !== activeCircleId && circles.some((c) => c.id === circleId)) {
      void setActiveCircle(circleId);
    }
    const next = new URLSearchParams(searchParams);
    next.delete(NOTIFICATION_CIRCLE_PARAM);
    setSearchParams(next, { replace: true });
  }, [circleId, circles, activeCircleId, setActiveCircle, searchParams, setSearchParams]);
}
