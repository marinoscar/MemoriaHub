/**
 * Unit tests for useFittedCount.
 *
 * useFittedCount(ref, itemWidth, gap) observes the container element via
 * ResizeObserver and returns:
 *
 *   Math.max(1, Math.floor((containerWidth + gap) / (itemWidth + gap)))
 *
 * JSDOM LIMITATIONS
 * -----------------
 * Two jsdom constraints affect this hook:
 *
 * 1. ResizeObserver in setup.ts is mocked as a stub whose `.observe()` is a
 *    no-op (never fires callbacks).  The hook therefore never receives a
 *    resize notification inside tests.
 *
 * 2. `el.getBoundingClientRect()` always returns `{width: 0, …}` in jsdom,
 *    so the "measure immediately on mount" call inside the useEffect also
 *    produces Math.max(1, 0) = 1.
 *
 * Because the ResizeObserver callback is never triggered, triggering a real
 * resize event via the mock requires monkey-patching the global constructor
 * to capture the callback and invoke it manually — that approach is used in
 * the "simulated resize" test below.
 *
 * The seed state (window.innerWidth-based) is computed in useState's
 * initializer, which runs synchronously before the useEffect that calls
 * getBoundingClientRect.  Since window.innerWidth defaults to 1024 in jsdom,
 * the initial count for (itemWidth=80, gap=12) would be:
 *   floor((1024 + 12) / (80 + 12)) = floor(11.26) = 11
 * BUT the useEffect on the first render immediately calls
 * getBoundingClientRect().width (= 0) and overrides the seed with 1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useFittedCount } from '../useFittedCount';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders useFittedCount with a fresh ref, optionally giving the element a
 * mocked getBoundingClientRect width.
 */
function renderFittedCount(
  itemWidth: number,
  gap: number,
  elementWidth = 0,
) {
  return renderHook(() => {
    const ref = useRef<HTMLDivElement>(document.createElement('div'));

    // Stub getBoundingClientRect on the element so mount-time measurement
    // returns the given width instead of jsdom's default 0.
    ref.current.getBoundingClientRect = () =>
      ({
        width: elementWidth,
        height: 0,
        top: 0,
        left: 0,
        right: elementWidth,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

    return useFittedCount(ref, itemWidth, gap);
  });
}

// ---------------------------------------------------------------------------

describe('useFittedCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Formula correctness
  // -------------------------------------------------------------------------
  describe('formula: floor((width + gap) / (itemWidth + gap))', () => {
    it('returns the correct count for a wide container (800px, 96px tiles, 12px gap)', () => {
      // floor((800 + 12) / (96 + 12)) = floor(812 / 108) = floor(7.52) = 7
      const { result } = renderFittedCount(96, 12, 800);
      expect(result.current).toBe(7);
    });

    it('returns the correct count for a narrow container (300px, 96px tiles, 12px gap)', () => {
      // floor((300 + 12) / (96 + 12)) = floor(312 / 108) = floor(2.89) = 2
      const { result } = renderFittedCount(96, 12, 300);
      expect(result.current).toBe(2);
    });

    it('returns 1 when the container is exactly one tile wide', () => {
      // floor((96 + 12) / (96 + 12)) = floor(1) = 1
      const { result } = renderFittedCount(96, 12, 96);
      expect(result.current).toBe(1);
    });

    it('returns 1 when the container is smaller than one tile', () => {
      // floor((50 + 12) / (96 + 12)) = floor(0.57) = 0 → clamped to 1
      const { result } = renderFittedCount(96, 12, 50);
      expect(result.current).toBe(1);
    });

    it('returns 1 when containerWidth is 0 (jsdom default)', () => {
      // This is the normal jsdom scenario: getBoundingClientRect returns 0.
      // floor((0 + 12) / (80 + 12)) = floor(0.13) = 0 → clamped to 1
      const { result } = renderFittedCount(80, 12, 0);
      expect(result.current).toBe(1);
    });

    it('handles a zero gap correctly', () => {
      // floor((480 + 0) / (96 + 0)) = floor(5) = 5
      const { result } = renderFittedCount(96, 0, 480);
      expect(result.current).toBe(5);
    });

    it('always returns at least 1 regardless of how small the container is', () => {
      const { result } = renderFittedCount(200, 16, 10);
      expect(result.current).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Simulated resize via callback capture
  // -------------------------------------------------------------------------
  describe('reacts to simulated ResizeObserver callback', () => {
    let capturedCallback: ResizeObserverCallback | null = null;
    let OriginalResizeObserver: typeof ResizeObserver;

    beforeEach(() => {
      OriginalResizeObserver = global.ResizeObserver;
      // Replace the stub with a version that captures the callback
      global.ResizeObserver = class MockCapturing {
        constructor(cb: ResizeObserverCallback) {
          capturedCallback = cb;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      } as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      global.ResizeObserver = OriginalResizeObserver;
      capturedCallback = null;
    });

    it('updates the count when the ResizeObserver callback fires with a new width', () => {
      const { result } = renderFittedCount(96, 12, 0);

      // Initial state: getBoundingClientRect = 0 → count = 1
      expect(result.current).toBe(1);

      // Simulate a resize to 500px
      // floor((500 + 12) / (96 + 12)) = floor(512 / 108) = floor(4.74) = 4
      act(() => {
        if (capturedCallback) {
          capturedCallback(
            [
              {
                contentBoxSize: [{ inlineSize: 500, blockSize: 100 }],
                contentRect: { width: 500 } as DOMRectReadOnly,
                borderBoxSize: [],
                devicePixelContentBoxSize: [],
                target: document.createElement('div'),
              },
            ],
            {} as ResizeObserver,
          );
        }
      });

      expect(result.current).toBe(4);
    });

    it('clamps to 1 when the resize fires with width 0', () => {
      const { result } = renderFittedCount(96, 12, 400);

      act(() => {
        if (capturedCallback) {
          capturedCallback(
            [
              {
                contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                contentRect: { width: 0 } as DOMRectReadOnly,
                borderBoxSize: [],
                devicePixelContentBoxSize: [],
                target: document.createElement('div'),
              },
            ],
            {} as ResizeObserver,
          );
        }
      });

      expect(result.current).toBe(1);
    });
  });
});
