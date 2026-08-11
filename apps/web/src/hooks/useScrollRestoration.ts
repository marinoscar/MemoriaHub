import { useEffect } from 'react';

/** How long to keep retrying a restore before giving up, in ms. */
const RESTORE_DEADLINE_MS = 1000;

/**
 * Restore the document's scroll position when a list-like page is returned to.
 *
 * Epic #388 / issue #389 makes the admin surface a phone drill-down, and spec
 * §4.4 calls scroll restoration "the single make-or-break detail": returning
 * from a detail page to a 20-card hub and landing at the top — forcing the user
 * to re-find their place — is precisely what makes drill-down feel bad rather
 * than native. Phases 2 and 3 build two more hubs on the same pattern, so this
 * is written as a generic hook rather than folded into `SettingsHubPage`.
 *
 * Three properties of this app decide the implementation:
 *
 *  1. **The scroller is the DOCUMENT.** `Layout.tsx`'s shell sets
 *     `minHeight: 100dvh` and `<main>` is not an overflow container — the whole
 *     page scrolls — so the position lives in `window.scrollY`, not in some
 *     element's `scrollTop`. (`TimelineScrubber` already relies on the same
 *     fact.)
 *  2. **The page fully unmounts** when the user drills into a detail route, so
 *     the offset cannot live in component state. `sessionStorage` survives the
 *     remount (and a reload) while staying scoped to the tab, which is the
 *     right lifetime for a scroll offset.
 *  3. **Content renders asynchronously.** At mount the document is usually far
 *     shorter than the saved offset, so a single `scrollTo` silently clamps to
 *     the current bottom. This is why SPAs break restoration by default:
 *     `history.pushState` restores nothing, and the browser cannot know the
 *     eventual page height. The fix is to retry until the target is reachable.
 *
 * @param key      Stable identifier for the scrolled surface, e.g.
 *                 `'admin-settings-hub'`. Namespaced into the storage key so
 *                 two surfaces never share an offset.
 * @param options  `enabled` (default `true`) makes the hook a no-op — useful
 *                 when a page should only restore in one of its modes. The
 *                 hook itself is still called unconditionally, per the rules
 *                 of hooks.
 */
export function useScrollRestoration(
  key: string,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;

  useEffect(() => {
    // SSR / DOM-less test environments: nothing to save or restore.
    if (!enabled || typeof window === 'undefined') return;

    const storageKey = `mh:scroll:${key}`;

    // Safari in private mode throws on ANY `sessionStorage` access, not just
    // writes, so every touch of it is wrapped. A failure degrades to "no
    // restoration" — never to a crashed page.
    const read = (): number => {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw === null) return 0;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      } catch {
        return 0;
      }
    };

    const write = (value: number): void => {
      try {
        window.sessionStorage.setItem(storageKey, String(Math.round(value)));
      } catch {
        /* storage unavailable — restoration is a nicety, not a requirement */
      }
    };

    let cancelled = false;
    let saveFrame: number | null = null;
    let restoreFrame: number | null = null;
    // True only across the handful of frames spanning our own programmatic
    // scroll, so the resulting scroll event is not mistaken for a user gesture.
    let selfScrolling = false;

    const abortRestore = () => {
      if (restoreFrame !== null) {
        window.cancelAnimationFrame(restoreFrame);
        restoreFrame = null;
      }
    };

    // --- Save -------------------------------------------------------------
    // Coalesced through rAF: a scroll gesture fires dozens of events per
    // second, and a synchronous `setItem` on each is a measurable jank source.
    // One write per painted frame is both sufficient and cheap.
    const handleScroll = () => {
      if (selfScrolling) return;
      // A genuine gesture wins outright — restoration must never fight the
      // user for control of the viewport.
      abortRestore();
      if (saveFrame !== null) return;
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = null;
        write(window.scrollY);
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    // --- Restore ----------------------------------------------------------
    const target = read();
    if (target > 0) {
      const deadline = Date.now() + RESTORE_DEADLINE_MS;

      const attempt = () => {
        restoreFrame = null;
        if (cancelled) return;

        const maxScroll =
          document.documentElement.scrollHeight - window.innerHeight;

        if (maxScroll >= target) {
          // The document is finally tall enough to honour the saved offset.
          // ALWAYS instant: smooth-scrolling to a position the user was
          // already at reads as the page sliding out from under them, and the
          // long animation would keep colliding with the gesture guard above.
          selfScrolling = true;
          window.scrollTo({ top: target, behavior: 'auto' });
          // Release the guard once the resulting scroll event has been
          // dispatched — two frames is comfortably past it, and the worst case
          // of being wrong is one skipped save, since restoration is done.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              selfScrolling = false;
            });
          });
          return;
        }

        // Still short — content is presumably mid-fetch or mid-render. Retry
        // next frame, but only until the deadline: past it the page is most
        // likely genuinely shorter than before (a card removed, a filter
        // applied), and continuing to poll would burn frames forever.
        if (Date.now() >= deadline) return;
        restoreFrame = window.requestAnimationFrame(attempt);
      };

      restoreFrame = window.requestAnimationFrame(attempt);
    }

    return () => {
      cancelled = true;
      abortRestore();
      window.removeEventListener('scroll', handleScroll);
      if (saveFrame !== null) {
        window.cancelAnimationFrame(saveFrame);
        saveFrame = null;
      }
      // The pending rAF write (if any) was just cancelled, and a navigation can
      // unmount between the last scroll event and its frame — so take one final
      // reading here rather than losing up to a frame's worth of movement.
      write(window.scrollY);
    };
  }, [key, enabled]);
}
