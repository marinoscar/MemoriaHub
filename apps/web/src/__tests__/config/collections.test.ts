/**
 * Tests for the Collections registry (issue #391, epic #388, spec §4.6).
 *
 * The registry is authoritative for BOTH the desktop context pane
 * (`CollectionsList`) and the phone/tablet card grid (`CollectionsHubPage`) —
 * see `src/config/collections.tsx`'s module doc. This file pins the two
 * properties that make it trustworthy as a shared source of truth: the fixed
 * ordering the spec calls out, and the one entry (Favorites) whose path has a
 * documented real-world failure mode if it drifts.
 *
 * Route-existence is checked the same way `navigation/reachability.test.tsx`
 * and `config/destinations.test.ts` check it — by statically parsing the
 * ACTUAL `App.tsx` route table, so a future route rename/removal fails this
 * file rather than silently leaving a card that 404s.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { COLLECTIONS } from '../../config/collections';

// ---------------------------------------------------------------------------
// Parse the live App.tsx route table (same technique as the other nav specs)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX_PATH = resolve(HERE, '../../App.tsx');

function extractRoutePaths(source: string): string[] {
  const matches = source.matchAll(/<Route\s+path="([^"]+)"/g);
  return Array.from(matches, (m) => m[1]);
}

const appSource = readFileSync(APP_TSX_PATH, 'utf-8');
const routePathSet = new Set(extractRoutePaths(appSource));

/** Strip a query string off a path, e.g. '/media?favorite=1' -> '/media'. */
function pathWithoutQuery(path: string): string {
  return path.split('?')[0];
}

describe('COLLECTIONS registry', () => {
  it('parses a realistic number of routes out of App.tsx (parser sanity check)', () => {
    // Guards the guard: if the regex ever stops matching anything, every
    // "route exists" assertion below would pass vacuously.
    expect(routePathSet.size).toBeGreaterThan(40);
  });

  // =========================================================================
  // Ordering — authoritative for both surfaces
  // =========================================================================

  describe('entry order (spec §4.6)', () => {
    it('declares the primary five in the documented order: albums, people, places, memories, map', () => {
      const primaryKeys = COLLECTIONS.filter((c) => c.group === 'primary').map((c) => c.key);
      expect(primaryKeys).toEqual(['albums', 'people', 'places', 'memories', 'map']);
    });

    it('declares the secondary three after the primary five, in the documented order: favorites, archive, trash', () => {
      const keys = COLLECTIONS.map((c) => c.key);
      expect(keys).toEqual([
        'albums',
        'people',
        'places',
        'memories',
        'map',
        'favorites',
        'archive',
        'trash',
      ]);
    });

    it('every primary entry sits before every secondary entry (the divider boundary)', () => {
      const groups = COLLECTIONS.map((c) => c.group);
      const firstSecondaryIndex = groups.indexOf('secondary');
      expect(firstSecondaryIndex).toBeGreaterThan(-1);
      expect(groups.slice(0, firstSecondaryIndex).every((g) => g === 'primary')).toBe(true);
      expect(groups.slice(firstSecondaryIndex).every((g) => g === 'secondary')).toBe(true);
    });

    it('has exactly 8 entries — five primary, three secondary', () => {
      expect(COLLECTIONS).toHaveLength(8);
      expect(COLLECTIONS.filter((c) => c.group === 'primary')).toHaveLength(5);
      expect(COLLECTIONS.filter((c) => c.group === 'secondary')).toHaveLength(3);
    });
  });

  // =========================================================================
  // Favorites path — the =1 trap (spec §4.6)
  //
  // MediaLibraryPage reads the query param as the literal string '1'
  // (`searchParams.get('favorite') === '1'`), so `favorite=true` does not
  // error — it silently renders an UNFILTERED library that looks like a
  // working Favorites view containing every photo. Pinning the exact literal
  // is the only thing that catches a regression to that value.
  // =========================================================================

  describe('Favorites path', () => {
    it('is exactly "/media?favorite=1"', () => {
      const favorites = COLLECTIONS.find((c) => c.key === 'favorites');
      expect(favorites).toBeDefined();
      expect(favorites!.path).toBe('/media?favorite=1');
    });

    it('is NOT "/media?favorite=true" or any other spelling', () => {
      const favorites = COLLECTIONS.find((c) => c.key === 'favorites');
      expect(favorites!.path).not.toBe('/media?favorite=true');
      expect(favorites!.path).not.toBe('/media?favorite');
      expect(favorites!.path).not.toBe('/media?favorites=1');
    });
  });

  // =========================================================================
  // Every entry's path resolves to a real route
  // =========================================================================

  describe('every entry points at a route that exists in App.tsx', () => {
    it.each(COLLECTIONS.map((c) => [c.key, c.path] as const))(
      '%s -> %s resolves to a declared <Route path>',
      (_key, path) => {
        expect(routePathSet.has(pathWithoutQuery(path))).toBe(true);
      },
    );
  });

  // =========================================================================
  // Structural sanity
  // =========================================================================

  describe('structural invariants', () => {
    it('every key is unique', () => {
      const keys = COLLECTIONS.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('every entry with a non-null source names one of the four fetchable sources', () => {
      COLLECTIONS.forEach((entry) => {
        if (entry.source === null) return;
        expect(['albums', 'people', 'places', 'memories']).toContain(entry.source);
      });
    });

    it('only the memories entry carries the memories flag; everything else is unflagged', () => {
      COLLECTIONS.forEach((entry) => {
        if (entry.key === 'memories') {
          expect(entry.flag).toBe('memories');
        } else {
          expect(entry.flag).toBeNull();
        }
      });
    });

    it('Map, Favorites, Archive, and Trash carry no source — they are icon-only entries', () => {
      const sourceless = COLLECTIONS.filter((c) => c.source === null).map((c) => c.key);
      expect(sourceless.sort()).toEqual(['archive', 'favorites', 'map', 'trash']);
    });
  });
});
