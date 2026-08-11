/**
 * Tests for the destination model (issue #390, epic #388, spec §3.5).
 *
 * The route-ownership guard mirrors `navigation/reachability.test.tsx`'s
 * approach: it statically parses the ACTUAL `src/App.tsx` for its declared
 * `<Route path="...">` set, rather than hand-maintaining a second "known
 * routes" list here that could silently drift from the real router. That is
 * what makes this a genuine regression guard — a future route addition that
 * forgets to extend `DESTINATION_ROUTES` (or that collides with an existing
 * prefix) fails this file, not just a manual QA pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  owns,
  resolveActiveDestination,
  DESTINATION_ROUTES,
  UNOWNED_ROUTES,
  type DestinationKey,
} from '../../config/destinations';

// ---------------------------------------------------------------------------
// Parse the live App.tsx route table (same technique as reachability.test.tsx)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX_PATH = resolve(HERE, '../../App.tsx');

function extractRoutePaths(source: string): string[] {
  const matches = source.matchAll(/<Route\s+path="([^"]+)"/g);
  return Array.from(matches, (m) => m[1]);
}

/** `:param` segments carry no meaning for prefix ownership, but a concrete
 * value keeps the fixture honest about what a real URL looks like. */
function normalizeParams(path: string): string {
  return path.replace(/:[^/]+/g, 'sample-id');
}

const appSource = readFileSync(APP_TSX_PATH, 'utf-8');
const rawRoutePaths = Array.from(new Set(extractRoutePaths(appSource)));
const normalizedRoutePaths = Array.from(new Set(rawRoutePaths.map(normalizeParams)));

/** Every destination whose prefix table owns `path`, independent of the
 * longest-prefix tie-break `resolveActiveDestination` applies — this is what
 * lets the "at most one owner" assertion catch a genuine collision even when
 * `resolveActiveDestination` would silently pick a winner. */
function owningDestinations(path: string): DestinationKey[] {
  return (Object.entries(DESTINATION_ROUTES) as [DestinationKey, readonly string[]][])
    .filter(([, prefixes]) => prefixes.some((prefix) => owns(prefix, path)))
    .map(([key]) => key);
}

describe('destinations config', () => {
  // ===========================================================================
  // Parser sanity check — guards the guard, same rationale as reachability.test.tsx
  // ===========================================================================

  it('parses a realistic number of routes out of App.tsx', () => {
    expect(rawRoutePaths.length).toBeGreaterThan(40);
  });

  // ===========================================================================
  // Required case 1: a route is owned by AT MOST one destination
  // ===========================================================================

  describe('route ownership — at most one destination per route', () => {
    it.each(normalizedRoutePaths)('%s is owned by zero or one destination, never two', (path) => {
      const owners = owningDestinations(path);
      expect(owners.length).toBeLessThanOrEqual(1);
    });

    it('resolveActiveDestination never throws and agrees with the ownership count for every declared route', () => {
      normalizedRoutePaths.forEach((path) => {
        const owners = owningDestinations(path);
        const resolved = resolveActiveDestination(path);
        if (owners.length === 0) {
          expect(resolved).toBeNull();
        } else {
          expect(resolved).toBe(owners[0]);
        }
      });
    });
  });

  // ===========================================================================
  // Required case 3: specific routes resolve to null, asserted deliberately
  // ===========================================================================

  describe('UNOWNED_ROUTES resolve to no destination', () => {
    it.each(UNOWNED_ROUTES)('%s resolves to null', (path) => {
      expect(resolveActiveDestination(path)).toBeNull();
    });

    // Pinned individually too, so a future contributor cannot "fix" one of
    // these into highlighting something arbitrary without this file noticing.
    it.each(['/settings', '/profile', '/circles', '/notifications'])(
      '%s resolves to null (not some other destination)',
      (path) => {
        expect(resolveActiveDestination(path)).toBeNull();
      },
    );
  });

  // ===========================================================================
  // Required case 2: boundary matching
  // ===========================================================================

  describe('segment-boundary matching', () => {
    it('/reviewer does NOT activate Review', () => {
      expect(resolveActiveDestination('/reviewer')).not.toBe('review');
      expect(resolveActiveDestination('/reviewer')).toBeNull();
    });

    it('/burstsfoo does NOT activate Review', () => {
      expect(resolveActiveDestination('/burstsfoo')).not.toBe('review');
      expect(resolveActiveDestination('/burstsfoo')).toBeNull();
    });

    it('/media-something does NOT activate Photos', () => {
      expect(resolveActiveDestination('/media-something')).not.toBe('photos');
      expect(resolveActiveDestination('/media-something')).toBeNull();
    });

    it('/ activates Photos, and ONLY on exact match', () => {
      expect(resolveActiveDestination('/')).toBe('photos');
      expect(resolveActiveDestination('/photos')).not.toBe('photos');
    });

    it('/review-insights activates Review via its OWN prefix — it is not a child of /review', () => {
      // The subtle one: a bare `startsWith('/review')` would also match this,
      // but `owns('/review', ...)` requires a `/` continuation, so it does NOT.
      expect(owns('/review', '/review-insights')).toBe(false);
      expect(resolveActiveDestination('/review-insights')).toBe('review');
    });

    it('/review-runs/x activates Review via its OWN prefix — it is not a child of /review', () => {
      expect(owns('/review', '/review-runs/x')).toBe(false);
      expect(resolveActiveDestination('/review-runs/x')).toBe('review');
    });
  });

  // ===========================================================================
  // Nested routes resolve to their parent destination
  // ===========================================================================

  describe('nested routes resolve to their parent', () => {
    it.each([
      ['/albums/sample-id', 'collections'],
      ['/bursts/sample-id', 'review'],
      ['/workflows/sample-id/runs/sample-id', 'review'],
      ['/admin/settings/jobs', 'console'],
    ] as const)('%s -> %s', (path, expected) => {
      expect(resolveActiveDestination(path)).toBe(expected);
    });
  });

  // ===========================================================================
  // The Collections hub (issue #391, spec §3.4 / §3.5 / §4.6)
  //
  // `/collections` is a route App.tsx added for this issue (the generic
  // "every declared route has zero or one owner" sweep above already covers
  // it since it parses the live route table) — pinned again explicitly here,
  // plus every browse route the hub folds in, so a future edit to
  // `DESTINATION_ROUTES.collections` that drops one of them fails loudly and
  // specifically rather than only inside the generic sweep.
  // ===========================================================================

  describe('the Collections hub route and the routes it folds in', () => {
    it('/collections resolves to the collections destination', () => {
      expect(resolveActiveDestination('/collections')).toBe('collections');
    });

    it.each([
      '/collections',
      '/albums',
      '/people',
      '/places',
      '/memories',
      '/map',
      '/archive',
      '/trash',
      '/tags',
    ])('DESTINATION_ROUTES.collections owns %s', (prefix) => {
      expect(DESTINATION_ROUTES.collections).toContain(prefix);
    });

    it.each([
      ['/albums', 'collections'],
      ['/people', 'collections'],
      ['/places', 'collections'],
      ['/memories', 'collections'],
      ['/map', 'collections'],
      ['/archive', 'collections'],
      ['/trash', 'collections'],
    ] as const)('%s resolves to %s, not some other destination', (path, expected) => {
      expect(resolveActiveDestination(path)).toBe(expected);
    });
  });

  // ===========================================================================
  // owns() — the primitive every rule above is built on
  // ===========================================================================

  describe('owns()', () => {
    it('matches the exact prefix', () => {
      expect(owns('/review', '/review')).toBe(true);
    });

    it('matches a child at a genuine segment boundary', () => {
      expect(owns('/review', '/review/bursts')).toBe(true);
    });

    it('rejects a same-string-prefix that is not a segment child', () => {
      expect(owns('/review', '/reviewer')).toBe(false);
    });

    it('"/" matches only the exact root, never every path', () => {
      expect(owns('/', '/')).toBe(true);
      expect(owns('/', '/anything')).toBe(false);
    });
  });
});
