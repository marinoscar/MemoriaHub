import { useEffect, useRef, useState } from 'react';

/**
 * Computes how many items of a fixed width fit in one row inside the given
 * container element, taking the gap between items into account.
 *
 * The formula is:  floor((containerWidth + gap) / (itemWidth + gap))
 * which correctly handles the fact that there is no trailing gap after the
 * last item.
 *
 * @param ref       - A ref attached to the measuring container element.
 * @param itemWidth - The fixed pixel width of each item tile.
 * @param gap       - The pixel gap between tiles (default handled by caller).
 * @returns The number of whole tiles that fit, always at least 1.
 */
export function useFittedCount(
  ref: React.RefObject<HTMLElement | null>,
  itemWidth: number,
  gap: number,
): number {
  // Seed with a guess derived from the current viewport so the first render
  // already shows a reasonable number of tiles instead of an empty flash.
  const [count, setCount] = useState<number>(() => {
    if (typeof window === 'undefined') return 4;
    return Math.max(1, Math.floor((window.innerWidth + gap) / (itemWidth + gap)));
  });

  // Keep a stable ref to the latest itemWidth/gap values so the effect does
  // not need to re-subscribe every time they change (they are constant in
  // practice, but TypeScript does not know that).
  const itemWidthRef = useRef(itemWidth);
  const gapRef = useRef(gap);
  useEffect(() => {
    itemWidthRef.current = itemWidth;
    gapRef.current = gap;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = (width: number) =>
      Math.max(1, Math.floor((width + gapRef.current) / (itemWidthRef.current + gapRef.current)));

    // Measure immediately on mount.
    setCount(compute(el.getBoundingClientRect().width));

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // contentBoxSize is more reliable than contentRect on some browsers.
      const width =
        entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      setCount(compute(width));
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]); // ref identity is stable; itemWidth/gap accessed via refs above

  return count;
}
