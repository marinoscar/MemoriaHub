/**
 * Reachability regression (issue #389, epic #388, spec §9).
 *
 * The single most important test in this epic: issue #389 deletes eight
 * drawer rows (Circles, Notifications, User Settings, Settings, Job Queue,
 * Worker Nodes, Storage Insights, Public Sharing) because each duplicates
 * chrome that is already on screen elsewhere. Deleting a NAV ROW must never
 * delete the ROUTE it pointed at — every one of those destinations remains
 * reachable via a URL (Console mode, a bookmark, a deep link, browser
 * back/forward), even though no drawer entry names it directly anymore.
 *
 * Approach: a real `MemoryRouter` render at each path would need the full
 * provider stack (Auth, Circle, Theme, MSW-backed data fetches for every
 * lazy-loaded page component) mocked to the point of tautology — asserting
 * little beyond "our own mocks resolved". Instead this statically parses the
 * ACTUAL `src/App.tsx` source for its `<Route path="...">` declarations and
 * checks the required paths are present in that set. This is a genuine
 * regression guard, not a tautology: deleting (or renaming, or moving outside
 * the parsed <Routes> tree) any of the `<Route path="...">` lines below makes
 * this test fail, because the string is re-extracted from the file on every
 * run rather than hardcoded as "known good".
 *
 * The parse is intentionally strict about what counts as a route declaration
 * (`<Route path="...">` exactly, one match per opening tag) precisely so it
 * cannot silently match zero routes and pass vacuously — the sanity check at
 * the bottom of this file asserts a realistic minimum route count for that
 * reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// NOTE: deliberately `dirname(...)` + `resolve(...)` rather than the more
// idiomatic `new URL('../../App.tsx', import.meta.url)` — Vite statically
// analyzes that exact `new URL(relative, import.meta.url)` shape as an asset
// reference and rewrites it, which under Vitest's transform produces a
// non-URL value and a confusing "TypeError: Invalid URL" at collection time.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX_PATH = resolve(HERE, '../../App.tsx');

/**
 * Extract every `<Route path="...">` declaration from the raw source text.
 * Deliberately does NOT try to parse JSX/TSX with a real parser — a plain
 * regex over the source is more resilient to this file's own churn (import
 * ordering, comments, formatting) while still failing hard if a `path="..."`
 * attribute is removed, renamed, or the `<Route` tag itself disappears.
 */
function extractRoutePaths(source: string): string[] {
  const matches = source.matchAll(/<Route\s+path="([^"]+)"/g);
  return Array.from(matches, (m) => m[1]);
}

const appSource = readFileSync(APP_TSX_PATH, 'utf-8');
const routePaths = extractRoutePaths(appSource);
const routePathSet = new Set(routePaths);

// The eight destinations that lost their dedicated Sidebar row in issue #389
// (spec §1.2 / §3.2), plus the routes their replacements now point at.
const REQUIRED_REACHABLE_PATHS = [
  '/circles', // was: drawer "Circles" row -> now: UserMenu / CircleChip "Manage Circles"
  '/notifications', // was: drawer "Notifications" row -> now: AppBar bell -> "See all notifications"
  '/settings', // was: drawer "User Settings" row -> now: UserMenu "Settings"
  '/admin/settings', // was: implicit via the old drawer's admin shortcuts -> now: Sidebar "Console"
  '/admin/settings/jobs', // was: drawer "Job Queue" row -> now: Console > Operations > Job Queue
  '/admin/settings/nodes', // was: drawer "Worker Nodes" row -> now: Console > Operations > Worker Nodes
  '/admin/settings/storage/insights', // was: drawer "Storage Insights" row -> now: Console > Storage > Storage Insights
  '/admin/settings/sharing', // was: drawer "Public Sharing" row -> now: Console > Operations > Public Sharing
];

// Issue #390 (epic #388, spec §3.5 / §4.5 / §9) adds the Review hub. It ADDS a
// namespace; it does not replace one. The epic's central claim is that
// collapsing five UTILITIES rows into one badged "Review" row never makes
// anything unreachable — every queue's pre-existing standalone route must
// still resolve, because bookmarks, the Home review banners and the
// `review_queue_*` notification links all point at those routes directly, not
// at `/review/*`.
const REVIEW_HUB_PATHS = ['/review', '/review/:queue'];

// The six standalone routes ReviewQueuePage wraps (verbatim, never redirects)
// — these existed before #390 and must survive it unchanged.
const REVIEW_WRAPPED_STANDALONE_PATHS = [
  '/bursts',
  '/duplicates',
  '/review-insights',
  '/location-suggestions',
  '/enhancements',
  '/workflows',
];

describe('navigation reachability (issue #389)', () => {
  it('parses a realistic number of routes out of App.tsx (parser sanity check)', () => {
    // App.tsx currently declares 60+ routes. A number this low would mean the
    // regex broke (e.g. App.tsx switched to a different Route JSX shape) and
    // every assertion below would be vacuously trivial to satisfy — so this
    // guards the guard.
    expect(routePaths.length).toBeGreaterThan(40);
  });

  it.each(REQUIRED_REACHABLE_PATHS)(
    'the route removed drawer rows pointed at, %s, still exists in App.tsx',
    (path) => {
      expect(routePathSet.has(path)).toBe(true);
    },
  );

  it('every required path is declared exactly once (no accidental duplicate/shadowing route)', () => {
    REQUIRED_REACHABLE_PATHS.forEach((path) => {
      const occurrences = routePaths.filter((p) => p === path).length;
      expect(occurrences).toBe(1);
    });
  });

  it('none of the required paths resolve only through the wildcard fallback', () => {
    // The wildcard `<Route path="*">` redirects everything unmatched to "/".
    // If one of the required paths were accidentally deleted, React Router
    // would silently fall through to this and land the user on Home instead
    // of 404ing loudly — asserting the literal path string exists (above) is
    // what actually catches that, but this pins the fallback's shape too so
    // a future refactor of the catch-all doesn't quietly change what
    // "unreachable" looks like.
    expect(appSource).toMatch(/<Route\s+path="\*"\s+element=\{<Navigate to="\/" replace \/>\}/);
  });

  it('every required path sits inside the authenticated <Layout> route tree, not a bare public route', () => {
    // All eight are legitimately behind auth (admin console pages and
    // personal pages like /circles, /settings, /notifications) — pin that
    // they appear after the `<Route element={<Layout />}>` opening tag and
    // before its matching closing `</Route>` that precedes the full-bleed
    // Layout block, so a future refactor can't silently move one of them out
    // to a public, unauthenticated route without this test noticing.
    const layoutStart = appSource.indexOf('<Route element={<Layout />}>');
    const fullBleedStart = appSource.indexOf('<Route element={<Layout fullBleed />}>');
    expect(layoutStart).toBeGreaterThan(-1);
    expect(fullBleedStart).toBeGreaterThan(layoutStart);

    const layoutBlock = appSource.slice(layoutStart, fullBleedStart);
    REQUIRED_REACHABLE_PATHS.forEach((path) => {
      expect(layoutBlock).toContain(`<Route path="${path}"`);
    });
  });
});

// ===========================================================================
// The Review hub (issue #390, epic #388, spec §3.5 / §4.5 / §9)
//
// This is the epic's central claim, restated for this phase: `/review` is a
// NEW namespace layered on top of the existing queue routes, never a
// replacement for them. Sidebar.test.tsx already proves the five old
// UTILITIES rows are gone from the drawer; this file's job is to prove that
// removal didn't touch the router — every one of those six routes must still
// resolve directly, exactly as before #390, alongside the two new hub routes.
// ===========================================================================
describe('navigation reachability — the Review hub (issue #390)', () => {
  it.each(REVIEW_HUB_PATHS)('the new Review hub route %s exists in App.tsx', (path) => {
    expect(routePathSet.has(path)).toBe(true);
  });

  it.each(REVIEW_WRAPPED_STANDALONE_PATHS)(
    'the wrapped queue route %s still resolves on its own — the hub does not replace it',
    (path) => {
      expect(routePathSet.has(path)).toBe(true);
    },
  );

  it('none of the eight Review-related paths are declared more than once', () => {
    [...REVIEW_HUB_PATHS, ...REVIEW_WRAPPED_STANDALONE_PATHS].forEach((path) => {
      const occurrences = routePaths.filter((p) => p === path).length;
      expect(occurrences).toBe(1);
    });
  });

  it('none of the six wrapped standalone routes redirect to /review — each still renders its own page', () => {
    // A route that now merely forwards to the hub would technically satisfy
    // "the path exists", but would defeat the whole point of wrapping rather
    // than replacing. Pin that each is a real `<Route path="..." element={<...Page />}>`,
    // not a `<Navigate to="/review" .../>`.
    REVIEW_WRAPPED_STANDALONE_PATHS.forEach((path) => {
      const match = appSource.match(
        new RegExp(`<Route\\s+path="${path.replace('/', '\\/')}"\\s+element=\\{<([^\\s/>]+)`),
      );
      expect(match).not.toBeNull();
      expect(match![1]).not.toBe('Navigate');
    });
  });

  it('every Review-related required path sits inside the authenticated <Layout> route tree', () => {
    const layoutStart = appSource.indexOf('<Route element={<Layout />}>');
    const fullBleedStart = appSource.indexOf('<Route element={<Layout fullBleed />}>');
    const layoutBlock = appSource.slice(layoutStart, fullBleedStart);

    [...REVIEW_HUB_PATHS, ...REVIEW_WRAPPED_STANDALONE_PATHS].forEach((path) => {
      expect(layoutBlock).toContain(`<Route path="${path}"`);
    });
  });
});
