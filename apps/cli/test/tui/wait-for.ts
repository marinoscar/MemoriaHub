/**
 * test/tui/wait-for.ts
 *
 * Shared polling helpers for Ink TUI tests, replacing the fixed-duration
 * `setTimeout` "flush" pattern that several TUI specs used to wait for an
 * async render/state update to settle before asserting.
 *
 * A fixed sleep races against the real completion of the thing it's waiting
 * for (a mocked promise resolving, React/Ink's scheduler flushing a
 * re-render, a stdin write being processed). On a fast, uncontended local
 * machine the race is won every time; under CI's shared/contended runners —
 * or simply many TUI suites rendering concurrently in the same Jest worker —
 * the real work can still be in flight when the fixed sleep elapses,
 * producing an intermittent false failure (this is what caused
 * test/tui/menu-nav.spec.tsx and test/tui/circle-manager.spec.tsx to flake
 * under `--ci` / full-suite runs while passing reliably in isolation).
 *
 * These helpers poll for the actual condition instead of racing a guessed
 * duration. One subtlety found empirically: `useInput`'s stdin subscription
 * is re-armed via its own effect on every render, and that effect can commit
 * a hair AFTER `lastFrame()`'s string output already reflects the new state —
 * so sending the NEXT stdin write the instant the frame text matches can
 * land in the brief window between the old render's listener being torn
 * down and the new one being attached, and gets silently dropped. `settleMs`
 * (small, fixed, and independent of how long the awaited condition itself
 * took) covers exactly that gap without reintroducing the original race:
 * unlike the removed fixed sleeps, it only needs to bridge one extra effect
 * flush, not an entire async fetch/render chain of unknown duration.
 */

/**
 * Poll `lastFrame()` until `predicate` matches, or throw after `timeoutMs`.
 * Returns the frame that satisfied the predicate.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; settleMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const settleMs = opts.settleMs ?? 20;
  const start = Date.now();
  for (;;) {
    const frame = lastFrame() ?? '';
    if (predicate(frame)) {
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      return lastFrame() ?? frame;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitForFrame: predicate never matched within ${timeoutMs}ms. Last frame:\n${frame}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Poll a jest mock function until it has been called at least `times`
 * (default 1), or throw after `timeoutMs`.
 */
export async function waitForCalls(
  mockFn: { mock: { calls: unknown[] } },
  opts: { times?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const times = opts.times ?? 1;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  for (;;) {
    if (mockFn.mock.calls.length >= times) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitForCalls: expected >= ${times} call(s) within ${timeoutMs}ms, got ${mockFn.mock.calls.length}.`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
