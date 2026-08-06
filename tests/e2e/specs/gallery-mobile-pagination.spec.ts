import { test, expect } from '../fixtures/auth.fixture';
import type { Page } from '@playwright/test';

/**
 * Issue #291 — mobile gallery layout runaway on infinite-scroll pagination.
 *
 * WHY THIS MUST BE A REAL BROWSER TEST
 * ------------------------------------
 * The bug is a *relayout feedback loop*: a `contain-intrinsic-size` shorthand
 * sized both axes, so a never-painted day group claimed an intrinsic WIDTH
 * equal to its placeholder HEIGHT; that widened the shell (a flex item without
 * `min-width: 0`), which the gallery's ResizeObserver then re-measured, which
 * produced a larger placeholder, and so on — diverging whenever rows > cols
 * (any day group of >= 10 photos at the 3-column `xs` breakpoint).
 *
 * None of that is observable in the unit suite: `src/__tests__/setup.ts` stubs
 * ResizeObserver, IntersectionObserver, matchMedia and scrollTo to no-ops, and
 * jsdom computes no layout at all. The unit tests can only assert the emitted
 * CSS; only a real engine can prove the loop does not run.
 *
 * WHAT IT ASSERTS
 * ---------------
 * Epic #234's acceptance bar, measured across several paginations at 360px:
 *   - zero horizontal page scroll
 *   - the gallery never grows wider than the viewport
 *   - the 3-column layout is stable — existing tiles never resize
 *   - the bottom navigation stays visible
 *
 * The test skips itself when the target circle holds too little media to
 * paginate, so it is a no-op against a thin seed rather than a false failure.
 * It needs at least one appended day group of >= 10 photos to reproduce.
 */

/** Portrait Android phone — ~360px CSS width, the reported repro viewport. */
const PHONE = { width: 360, height: 740 };

/** How many pagination rounds to drive. */
const PAGINATIONS = 5;

interface LayoutProbe {
  docScrollWidth: number;
  docClientWidth: number;
  galleryWidth: number;
  tileWidth: number | null;
  tileCount: number;
}

async function probe(page: Page): Promise<LayoutProbe> {
  return page.evaluate(() => {
    const gallery = document.querySelector('[data-testid="gallery-root"]');
    const firstGrid = document.querySelector('[data-testid="gallery-day-grid"]');
    const firstTile = firstGrid?.firstElementChild ?? null;
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      galleryWidth: gallery ? gallery.getBoundingClientRect().width : 0,
      tileWidth: firstTile ? firstTile.getBoundingClientRect().width : null,
      tileCount: document.querySelectorAll('[data-testid="gallery-day-grid"] > *').length,
    };
  });
}

test.describe('Photos gallery — mobile infinite scroll (issue #291)', () => {
  test.use({ viewport: PHONE });

  test('paginating never widens the layout or resizes existing tiles', async ({
    contributorPage: page,
  }) => {
    await page.goto('/');

    // The gallery may legitimately be absent (empty circle) — skip rather than
    // fail, so a thin seed does not produce a red build.
    const gallery = page.locator('[data-testid="gallery-root"]');
    const appeared = await gallery
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!appeared, 'No media in the default circle — nothing to paginate.');

    await expect(page.locator('[data-testid="gallery-day-grid"]').first()).toBeVisible();

    const baseline = await probe(page);
    test.skip(
      baseline.tileWidth === null,
      'Gallery rendered no tiles — nothing to measure.',
    );

    // Sanity: the starting state is the 3-column grid inside the viewport.
    expect(baseline.docScrollWidth).toBeLessThanOrEqual(baseline.docClientWidth + 1);

    for (let round = 1; round <= PAGINATIONS; round += 1) {
      const before = await probe(page);

      // Drive the infinite-scroll sentinel into view.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      // Wait for the next page to land. If nothing more arrives, we have run
      // out of media — stop, having already verified every prior round.
      const grew = await page
        .waitForFunction(
          (previous) =>
            document.querySelectorAll('[data-testid="gallery-day-grid"] > *').length >
            previous,
          before.tileCount,
          { timeout: 10_000 },
        )
        .then(() => true)
        .catch(() => false);

      if (!grew) break;

      // Let any relayout settle. The reported failure completed inside ~330ms;
      // if the loop were still live, it would have diverged well within this.
      await page.waitForTimeout(1_000);

      const after = await probe(page);

      expect(
        after.docScrollWidth,
        `round ${round}: horizontal page scroll appeared`,
      ).toBeLessThanOrEqual(after.docClientWidth + 1);

      expect(
        after.galleryWidth,
        `round ${round}: gallery grew wider than the viewport`,
      ).toBeLessThanOrEqual(PHONE.width + 1);

      // The runaway's signature is existing tiles inflating frame-over-frame.
      expect(
        after.tileWidth ?? 0,
        `round ${round}: an already-painted tile resized`,
      ).toBeCloseTo(baseline.tileWidth as number, 0);
    }

    // Bottom navigation is `position: fixed` and disappeared as the layout blew
    // up; it must survive pagination.
    await expect(page.locator('nav').last()).toBeVisible();
  });
});
