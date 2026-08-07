/**
 * Guards the RBAC catalog against the three ways it can silently drift (#293).
 *
 * 1. catalog vs. `roles.constants.ts` — a permission the API guards on but that
 *    the catalog never creates is exactly the #293 failure mode: the route
 *    compiles, the row never exists, and the page 403s at runtime.
 * 2. catalog vs. `prisma/seed.ts` — the seed keeps a duplicate copy of this data
 *    because it CANNOT import from `src/` (the production image ships `dist/`,
 *    `prisma/` and `scripts/`, not `src/`, so a cross-import would break
 *    install-time seeding). The duplication is only safe while something proves
 *    the two stay identical. That is this file.
 * 3. internal consistency — a role granted a permission that is not in the
 *    catalog can never be reconciled into the database.
 *
 * The seed-parsing tests assert a plausible parse count BEFORE comparing. A
 * regex that silently matches nothing would otherwise turn every comparison
 * below into a vacuous pass — the test would go green precisely when it stopped
 * testing anything.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSIONS } from './roles.constants';
import { PERMISSION_CATALOG, ROLE_PERMISSION_MATRIX } from './rbac.catalog';

const SEED_PATH = join(__dirname, '..', '..', '..', 'prisma', 'seed.ts');

function readSeedSource(): string {
  return readFileSync(SEED_PATH, 'utf8');
}

/** Extracts `const <name> = [ ... ]` / `= { ... }` block bodies from the seed. */
function extractBlock(source: string, declaration: string, close: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(
      `Could not find "${declaration}" in prisma/seed.ts. If the seed was ` +
        `restructured, update this parser — do not delete the assertion.`,
    );
  }
  const end = source.indexOf(close, start);
  if (end === -1) {
    throw new Error(`Could not find the end ("${close}") of "${declaration}" in prisma/seed.ts.`);
  }
  return source.slice(start, end);
}

function seedPermissionNames(): string[] {
  const block = extractBlock(readSeedSource(), 'const PERMISSIONS = [', '] as const;');
  return [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

function seedRolePermissions(): Record<string, string[]> {
  const block = extractBlock(readSeedSource(), 'const ROLE_PERMISSIONS', '\n};');
  const result: Record<string, string[]> = {};

  for (const roleMatch of block.matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)^\s{2}\],?$/gm)) {
    const roleName = roleMatch[1];
    // Permission names only — comments in the block have no quoted strings.
    result[roleName] = [...roleMatch[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  return result;
}

describe('RBAC catalog', () => {
  const catalogNames = PERMISSION_CATALOG.map((p) => p.name as string);

  describe('internal consistency', () => {
    it('has no duplicate permission entries', () => {
      expect(catalogNames).toHaveLength(new Set(catalogNames).size);
    });

    it('gives every permission a non-empty description', () => {
      for (const permission of PERMISSION_CATALOG) {
        expect(permission.description.trim().length).toBeGreaterThan(0);
      }
    });

    it('only grants roles permissions that exist in the catalog', () => {
      for (const [roleName, granted] of Object.entries(ROLE_PERMISSION_MATRIX)) {
        const unknown = granted.filter((p) => !catalogNames.includes(p as string));
        expect({ roleName, unknown }).toEqual({ roleName, unknown: [] });
      }
    });

    it('grants no role a duplicate permission', () => {
      for (const [roleName, granted] of Object.entries(ROLE_PERMISSION_MATRIX)) {
        expect({ roleName, count: granted.length }).toEqual({
          roleName,
          count: new Set(granted).size,
        });
      }
    });
  });

  describe('parity with roles.constants.ts (the permissions @Auth guards on)', () => {
    const declaredNames = Object.values(PERMISSIONS) as string[];

    it('catalogs every permission declared in PERMISSIONS', () => {
      const missing = declaredNames.filter((name) => !catalogNames.includes(name));
      expect(missing).toEqual([]);
    });

    it('declares every catalogued permission in PERMISSIONS', () => {
      const extra = catalogNames.filter((name) => !declaredNames.includes(name));
      expect(extra).toEqual([]);
    });
  });

  describe('parity with prisma/seed.ts (deliberate duplicate — must not diverge)', () => {
    it('parses a plausible number of permissions from the seed', () => {
      // Fails loudly if the seed is reformatted and the regex stops matching,
      // rather than letting the comparisons below pass vacuously.
      expect(seedPermissionNames().length).toBeGreaterThan(30);
    });

    it('seeds exactly the catalogued permission set', () => {
      expect([...seedPermissionNames()].sort()).toEqual([...catalogNames].sort());
    });

    it('parses all three roles from the seed', () => {
      expect(Object.keys(seedRolePermissions()).sort()).toEqual([
        'admin',
        'contributor',
        'viewer',
      ]);
    });

    it('maps roles to exactly the catalogued permissions', () => {
      const fromSeed = seedRolePermissions();

      for (const [roleName, granted] of Object.entries(ROLE_PERMISSION_MATRIX)) {
        expect({ roleName, permissions: [...(fromSeed[roleName] ?? [])].sort() }).toEqual({
          roleName,
          permissions: [...granted].sort(),
        });
      }
    });
  });
});
