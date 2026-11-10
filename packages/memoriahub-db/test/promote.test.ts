import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoriahubSyncError, applyMemoriahubSync, checkMemoriahubInstall, planMemoriahubSync, promoteMemoriahubMigration, readManifest, sha256Hex } from '../src/index.js';
import { cleanup, freshHost, freshPackage } from './helpers.js';

afterEach(cleanup);

/** A host with the whole domain installed under original names, and a private copy of the package. */
function setup() {
  const root = freshHost();
  const packageDir = freshPackage();
  // The web app case: the host holds the history the baseline is adopted by.
  mkdirSync(join(root, 'prisma', 'migrations', '20260610000000_add_media_domain'), { recursive: true });
  writeFileSync(join(root, 'prisma', 'migrations', '20260610000000_add_media_domain', 'migration.sql'), '-- history\n');
  applyMemoriahubSync(planMemoriahubSync({ root, packageDir, names: 'original', platformSchemaDir: null }));
  return { root, packageDir };
}

function draft(root: string, dir: string, sql: string) {
  mkdirSync(join(root, 'prisma', 'migrations', dir), { recursive: true });
  writeFileSync(join(root, 'prisma', 'migrations', dir, 'migration.sql'), sql);
}

const GOOD = `-- AddColumn
ALTER TABLE "media_items" ADD COLUMN "promoted_probe" TEXT;
ALTER TABLE "albums" ADD CONSTRAINT "albums_probe_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`;

describe('promote', () => {
  it('moves a draft into the package under its timestamp, installs it and updates both locks', async () => {
    const { root, packageDir } = setup();
    draft(root, '20270301120000_add_probe', GOOD);
    const result = promoteMemoriahubMigration({ root, localDir: '20270301120000_add_probe', id: 'add_probe', slice: 'media', packageDir });
    expect(result).toMatchObject({ id: '20270301120000_add_probe', installedDir: '20270301120000_add_probe', requiresHostTables: ['users'] });

    const manifest = readManifest(join(packageDir, 'migrations'));
    const last = manifest.migrations[manifest.migrations.length - 1]!;
    expect(last).toEqual({ id: '20270301120000_add_probe', slice: 'media', sha256: sha256Hex(GOOD), requiresHostTables: ['users'] });
    expect(readFileSync(join(packageDir, 'migrations', last.id, 'migration.sql'), 'utf8')).toBe(GOOD);

    const lock = JSON.parse(readFileSync(join(root, 'prisma', 'memoriahub.lock'), 'utf8'));
    expect(lock.migrations[lock.migrations.length - 1]).toMatchObject({ originId: 'memoriahub:20270301120000_add_probe', installedDir: '20270301120000_add_probe' });
    const platform = JSON.parse(readFileSync(join(root, 'prisma', 'platform.lock'), 'utf8'));
    expect(platform.appMigrations).toContain('20270301120000_add_probe');
    expect((await checkMemoriahubInstall({ root, packageDir })).problems.map((p) => p.code)).toEqual([]);
  });

  it('renames a draft whose name differs from the id', () => {
    const { root, packageDir } = setup();
    draft(root, '20270301120000_scratch_name', GOOD);
    promoteMemoriahubMigration({ root, localDir: '20270301120000_scratch_name', id: 'add_probe', slice: 'media', packageDir });
    expect(existsSync(join(root, 'prisma', 'migrations', '20270301120000_scratch_name'))).toBe(false);
    expect(existsSync(join(root, 'prisma', 'migrations', '20270301120000_add_probe', 'migration.sql'))).toBe(true);
  });

  it('refuses a migration that changes a host table and leaves everything as it was', () => {
    const { root, packageDir } = setup();
    const manifestBefore = readFileSync(join(packageDir, 'migrations', 'manifest.json'), 'utf8');
    draft(root, '20270301120000_bad', 'ALTER TABLE "users" ADD COLUMN "x" TEXT;\n');
    expect(() => promoteMemoriahubMigration({ root, localDir: '20270301120000_bad', id: 'bad', slice: 'media', packageDir })).toThrow(/"users"/);
    expect(readFileSync(join(packageDir, 'migrations', 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(existsSync(join(packageDir, 'migrations', '20270301120000_bad'))).toBe(false);
  });

  it('refuses a foreign key to a table that is neither a domain nor a host table', () => {
    const { root, packageDir } = setup();
    draft(root, '20270301120000_fk', 'ALTER TABLE "albums" ADD CONSTRAINT "x_fkey" FOREIGN KEY ("added_by_id") REFERENCES "grants"("id");\n');
    expect(() => promoteMemoriahubMigration({ root, localDir: '20270301120000_fk', id: 'fk', slice: 'media', packageDir })).toThrow(/grants/);
  });

  it('refuses an id that sorts before the newest package migration, an unknown slice and a bad slug', () => {
    const { root, packageDir } = setup();
    draft(root, '20260101000000_old', GOOD);
    expect(() => promoteMemoriahubMigration({ root, localDir: '20260101000000_old', id: 'old', slice: 'media', packageDir })).toThrow(/reorder/);
    draft(root, '20270301120000_s', GOOD);
    expect(() => promoteMemoriahubMigration({ root, localDir: '20270301120000_s', id: 's', slice: 'nope', packageDir })).toThrow(MemoriahubSyncError);
    expect(() => promoteMemoriahubMigration({ root, localDir: '20270301120000_s', id: 'Bad Slug', slice: 'media', packageDir })).toThrow(/slug/);
  });

  it('warns about a new raw-SQL index that the inventory does not list', () => {
    const { root, packageDir } = setup();
    draft(root, '20270301120000_idx', 'CREATE UNIQUE INDEX "albums_probe_uniq_idx" ON "albums"("name") WHERE "name" IS NOT NULL;\n');
    const result = promoteMemoriahubMigration({ root, localDir: '20270301120000_idx', id: 'idx', slice: 'media', packageDir });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('albums_probe_uniq_idx');
  });
});
