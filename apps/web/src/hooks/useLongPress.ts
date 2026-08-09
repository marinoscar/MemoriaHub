import { useCallback, useRef } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';

const LONG_PRESS_MS = 500;
/** Movement past this cancels the press — the user is scrolling, not pressing. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onTouchStart: (event: ReactTouchEvent) => void;
  onTouchMove: (event: ReactTouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

/**
 * Touch long-press, used to reach a card's action menu on a phone where there
 * is no hover and the kebab is a small target.
 *
 * Touch only, deliberately: a mouse already has the kebab and a right-click
 * context menu, and hijacking `contextmenu` on desktop would take away the
 * browser's own (e.g. "open image in new tab"). Movement past a small tolerance
 * cancels, so a press that turns into a scroll never fires the menu — the
 * single most common false positive in a scrollable grid.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    originRef.current = null;
  }, []);

  const onTouchStart = useCallback((event: ReactTouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    originRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      callbackRef.current(touch.clientX, touch.clientY);
    }, LONG_PRESS_MS);
  }, []);

  const onTouchMove = useCallback(
    (event: ReactTouchEvent) => {
      const origin = originRef.current;
      const touch = event.touches[0];
      if (!origin || !touch || !timerRef.current) return;
      const moved =
        Math.abs(touch.clientX - origin.x) > MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - origin.y) > MOVE_TOLERANCE_PX;
      if (moved) cancel();
    },
    [cancel],
  );

  return { onTouchStart, onTouchMove, onTouchEnd: cancel, onTouchCancel: cancel };
}
