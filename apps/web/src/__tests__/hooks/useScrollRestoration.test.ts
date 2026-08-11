/**
 * Unit tests for useScrollRestoration (issue #389, epic #388).
 *
 * Scroll restoration is called out in the issue as "the criterion most likely
 * to regress silently" (spec §4.4) — a manual "seems fine" check would not
 * catch a future refactor that, say, swaps `window.scrollY` for an element's
 * `scrollTop`, or drops the rAF retry loop and starts clamping to whatever
 * height the page happens to have on the first frame. These tests drive the
 * hook directly with `renderHook`, so they exercise the real save/restore
 * state machine rather than a page that merely calls it.
 *
 * jsdom reports 0 for `document.documentElement.scrollHeight` and
 * `window.innerHeight` by default, so both are stubbed per test via
 * `Object.defineProperty(..., { configurable: true, value })`. `rAF`/`cAF`
 * are replaced with a hand-rolled, manually-flushable queue so the retry loop
 * can be driven deterministically frame-by-frame instead of racing real
 * timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';

// ---------------------------------------------------------------------------
// Manual rAF queue — lets each test decide exactly when a "frame" happens.
// ---------------------------------------------------------------------------

let nextId: number;
let queue: Map<number, FrameRequestCallback>;

function stubRaf() {
  nextId = 1;
  queue = new Map();

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback): number => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    }),
  );

  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number): void => {
      queue.delete(id);
    }),
  );
}

/** Run every callback currently queued (one simulated frame). New callbacks
 * scheduled by those callbacks land in the queue for the NEXT flush, mirroring
 * real rAF semantics. */
function flushFrame(): void {
  const callbacks = Array.from(queue.values());
  queue.clear();
  callbacks.forEach((cb) => cb(0));
}

function setDocumentHeight(scrollHeight: number, innerHeight: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: innerHeight,
  });
}

function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    value,
  });
}

const STORAGE_KEY = 'mh:scroll:test-key';

beforeEach(() => {
  stubRaf();
  window.sessionStorage.clear();
  // setup.ts already stubs window.scrollTo as a plain vi.fn(); replace it
  // with a fresh spy per test so call counts never leak across tests.
  window.scrollTo = vi.fn();
  setDocumentHeight(0, 0);
  setScrollY(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('useScrollRestoration', () => {
  describe('restore', () => {
    it('restores a saved offset once the document is tall enough', () => {
      window.sessionStorage.setItem(STORAGE_KEY, '500');
      setDocumentHeight(1000, 500); // maxScroll = 500 === target

      renderHook(() => useScrollRestoration('test-key'));

      // The initial restore attempt is scheduled synchronously in the mount
      // effect; one flushed frame is enough since the document is already
      // tall enough on the first try.
      flushFrame();

      expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'auto' });
    });

    it('retries across frames until the document grows tall enough', () => {
      window.sessionStorage.setItem(STORAGE_KEY, '800');
      setDocumentHeight(200, 500); // maxScroll = -300, far short of 800

      renderHook(() => useScrollRestoration('test-key'));

      flushFrame(); // attempt #1 — still short, schedules a retry
      expect(window.scrollTo).not.toHaveBeenCalled();

      flushFrame(); // attempt #2 — still short
      expect(window.scrollTo).not.toHaveBeenCalled();

      // Content has now rendered enough to satisfy the saved offset.
      setDocumentHeight(1300, 500); // maxScroll = 800

      flushFrame(); // attempt #3 — succeeds
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'auto' });
    });

    it('does not attempt to restore when there is no saved offset', () => {
      setDocumentHeight(2000, 500);

      renderHook(() => useScrollRestoration('test-key'));
      flushFrame();

      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      window.sessionStorage.setItem(STORAGE_KEY, '500');
      setDocumentHeight(1000, 500);

      renderHook(() => useScrollRestoration('test-key', { enabled: false }));
      flushFrame();
      flushFrame();

      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it('namespaces the storage key so two surfaces never collide', () => {
      window.sessionStorage.setItem('mh:scroll:other-key', '999');
      setDocumentHeight(2000, 500);

      // Mounting under 'test-key' must not pick up 'other-key''s saved value.
      renderHook(() => useScrollRestoration('test-key'));
      flushFrame();

      expect(window.scrollTo).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('writes the current scroll offset (coalesced through rAF) on a scroll event', () => {
      renderHook(() => useScrollRestoration('test-key'));

      setScrollY(240);
      window.dispatchEvent(new Event('scroll'));

      // Not written synchronously — coalesced to the next frame.
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

      flushFrame();

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('240');
    });

    it('coalesces many scroll events within one frame into a single write', () => {
      renderHook(() => useScrollRestoration('test-key'));

      const scheduleCalls = vi.mocked(window.requestAnimationFrame).mock.calls.length;

      setScrollY(10);
      window.dispatchEvent(new Event('scroll'));
      setScrollY(20);
      window.dispatchEvent(new Event('scroll'));
      setScrollY(30);
      window.dispatchEvent(new Event('scroll'));

      // Only one additional rAF was scheduled for the whole burst.
      expect(vi.mocked(window.requestAnimationFrame).mock.calls.length).toBe(scheduleCalls + 1);

      flushFrame();

      // The write reflects whatever scrollY was AT FLUSH TIME (the last of
      // the three), not the first event that triggered the schedule.
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('30');
    });
  });

  describe('unmount', () => {
    it('writes a final offset reading on unmount', () => {
      const { unmount } = renderHook(() => useScrollRestoration('test-key'));

      setScrollY(77);
      unmount();

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('77');
    });

    it('removes the scroll listener on unmount', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      const { unmount } = renderHook(() => useScrollRestoration('test-key'));

      unmount();

      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      removeSpy.mockRestore();
    });
  });

  describe('sessionStorage failures degrade gracefully', () => {
    it('does not throw when every sessionStorage access throws (e.g. Safari private mode)', () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      const throwing: Storage = {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      };
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: throwing,
      });

      try {
        setDocumentHeight(2000, 500);
        setScrollY(50);

        let renderResult: ReturnType<typeof renderHook> | undefined;
        expect(() => {
          renderResult = renderHook(() => useScrollRestoration('test-key'));
        }).not.toThrow();

        expect(() => flushFrame()).not.toThrow();

        window.dispatchEvent(new Event('scroll'));
        expect(() => flushFrame()).not.toThrow();

        expect(() => renderResult?.unmount()).not.toThrow();

        // A throwing read degrades to "nothing to restore" — no programmatic
        // scroll is ever attempted.
        expect(window.scrollTo).not.toHaveBeenCalled();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(window, 'sessionStorage', originalDescriptor);
        }
      }
    });
  });
});
