/**
 * Regression tests for GitHub issue #293.
 *
 * THE BUG: an admin opening /admin/settings/email in production got
 * "Missing permissions: email_settings:read". The email feature itself was
 * fine — the `email_settings:read` and `email_settings:write` rows simply did
 * not exist in that database.
 *
 * WHY: permission rows have only ever been created by `prisma/seed.ts`. The
 * seed runs at install time (`install-memoriahub.sh`) and nowhere else —
 * `update.sh` runs `prisma migrate deploy` WITHOUT it, and no migration had
 * ever inserted into `permissions`. Commit 18811b28 (2026-07-14) added
 * `email_settings:*` to the seed, long after the production instance was
 * installed, so those two rows never landed. Verified against production: the
 * seed defined 38 permissions, the database held 36 — missing exactly these two.
 *
 * WHY THIS FILE EXISTS — the important part: no unit test could have caught
 * this, because nothing was wrong with the code. `email-settings.controller.ts`
 * correctly guards on `PERMISSIONS.EMAIL_SETTINGS_READ`, and the seed correctly
 * listed it. The defect lived in the gap between the code and the deployed
 * database, so the assertions below pin the two mechanisms that close that gap
 * rather than re-testing the controller:
 *
 *   1. the backfill migration exists and is idempotent, so the fix reaches
 *      already-installed databases through the normal deploy path; and
 *   2. the permissions are in the catalog that `RbacReconcileService` applies
 *      on every boot, so this class of drift cannot recur for a future
 *      permission.
 *
 * See `rbac.catalog.spec.ts` for the catalog/seed parity guards and
 * `rbac-reconcile.service.spec.ts` for the reconciler's behaviour.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSIONS } from '../constants/roles.constants';
import { PERMISSION_CATALOG, ROLE_PERMISSION_MATRIX } from '../constants/rbac.catalog';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20260807000000_add_email_settings_permissions',
  'migration.sql',
);

describe('issue #293 — email_settings permissions reach existing deployments', () => {
  describe('the catalog (what RbacReconcileService applies on every boot)', () => {
    const catalogNames = PERMISSION_CATALOG.map((p) => p.name as string);

    it('contains both email_settings permissions', () => {
      expect(catalogNames).toEqual(
        expect.arrayContaining(['email_settings:read', 'email_settings:write']),
      );
    });

    it('matches the constants the controller guards on', () => {
      expect(PERMISSIONS.EMAIL_SETTINGS_READ).toBe('email_settings:read');
      expect(PERMISSIONS.EMAIL_SETTINGS_WRITE).toBe('email_settings:write');
      expect(catalogNames).toEqual(
        expect.arrayContaining([
          PERMISSIONS.EMAIL_SETTINGS_READ,
          PERMISSIONS.EMAIL_SETTINGS_WRITE,
        ]),
      );
    });

    it('grants both to admin — the role that was locked out of the page', () => {
      expect(ROLE_PERMISSION_MATRIX.admin).toEqual(
        expect.arrayContaining([
          PERMISSIONS.EMAIL_SETTINGS_READ,
          PERMISSIONS.EMAIL_SETTINGS_WRITE,
        ]),
      );
    });

    it('keeps them admin-only', () => {
      for (const role of ['contributor', 'viewer'] as const) {
        expect(ROLE_PERMISSION_MATRIX[role]).not.toContain(PERMISSIONS.EMAIL_SETTINGS_READ);
        expect(ROLE_PERMISSION_MATRIX[role]).not.toContain(PERMISSIONS.EMAIL_SETTINGS_WRITE);
      }
    });
  });

  describe('the backfill migration (what repairs already-installed databases)', () => {
    let sql: string;

    beforeAll(() => {
      // Throws if the migration was renamed or removed — deliberate. Without it
      // an existing deployment stays broken until the API next boots.
      sql = readFileSync(MIGRATION_PATH, 'utf8');
    });

    it('inserts both permissions', () => {
      expect(sql).toContain('email_settings:read');
      expect(sql).toContain('email_settings:write');
      expect(sql).toMatch(/INSERT INTO "permissions"/i);
    });

    it('grants them to the admin role', () => {
      expect(sql).toMatch(/INSERT INTO "role_permissions"/i);
      expect(sql).toMatch(/'admin'/);
    });

    it('is idempotent — safe on a freshly seeded database that already has them', () => {
      const conflictClauses = sql.match(/ON CONFLICT[\s\S]*?DO NOTHING/gi) ?? [];
      // One for the permissions insert, one for the role_permissions insert.
      expect(conflictClauses).toHaveLength(2);
    });

    it('uses the descriptions the catalog will reconcile to, so the two agree', () => {
      for (const name of ['email_settings:read', 'email_settings:write'] as const) {
        const catalogued = PERMISSION_CATALOG.find((p) => p.name === name);
        expect(catalogued).toBeDefined();
        expect(sql).toContain(catalogued!.description);
      }
    });
  });
});
