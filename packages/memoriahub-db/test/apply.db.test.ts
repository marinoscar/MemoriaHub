import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMemoriahubSync, checkMemoriahubInstall, planMemoriahubSync, readManifest } from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const adminUrl = process.env.DATABASE_URL;
const require = createRequire(__filename);

/**
 * Builds the domain twice and proves the two databases hold the same domain schema:
 *  - fresh: the platform's migrations, then the package baseline installed with a stable name;
 *  - history: the web app's whole migration history (apps/api/prisma/migrations), which adopts the
 *    baseline without running it.
 * `check --database` passes on both, and every domain column, constraint, index, trigger, RLS policy,
 * enum and function is equal. Runs only when DATABASE_URL points at a PostgreSQL 16 server with the
 * pgvector extension available and a role allowed to create databases and extensions (the test creates
 * and drops its own databases).
 */
describe.skipIf(!adminUrl)('memoriahub-db against a fresh database', () => {
  const name = `memoriahub_db_apply_${process.pid}`;
  const historyName = `${name}_history`;
  let url = '';
  let historyUrl = '';
  let root = '';
  type PgClient = { connect(): Promise<void>; query(sql: string): Promise<{ rows: Record<string, string>[] }>; end(): Promise<void> };
  const { Client } = require('pg') as { Client: new (config: { connectionString: string }) => PgClient };
  const withDatabase = (database: string) => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl! });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`DROP DATABASE IF EXISTS ${historyName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${historyName}`);
    await admin.end();
    url = withDatabase(name);
    historyUrl = withDatabase(historyName);

    // The host: an empty app folder that receives the platform's own migrations from the platform command, stamped from a pinned clock so they sort before the domain.
    root = mkdtempSync(join(tmpdir(), 'memoriahub-db-apply-'));
    const platformBin = join(require.resolve('@marinoscar/platform-db/package.json'), '..', 'bin', 'platform.js');
    const installed = spawnSync(process.execPath, [platformBin, 'db', 'sync', '--root', root, '--timestamp', '2024-01-01T00:00:00Z'], { encoding: 'utf8' });
    expect(installed.status, installed.stderr).toBe(0);
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    const admin = new Client({ connectionString: adminUrl! });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${historyName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies the platform history, then the baseline installed with a stable name, then passes check --database', async () => {
    const dirs = () => readdirSync(join(root, 'prisma', 'migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    const platformDirs = dirs();

    // The temp host sits outside the repository, so name the platform schema folder instead of resolving it from the host.
    const platformSchemaDir = join(require.resolve('@marinoscar/platform-db/package.json'), '..', 'schema');
    const plan = planMemoriahubSync({ root, names: 'stable', platformSchemaDir });
    expect(plan.installs.map((i) => i.action)).toEqual(['copy']);
    applyMemoriahubSync(plan);
    const all = dirs();
    const memoriahubDirs = all.filter((d) => !platformDirs.includes(d));
    expect(memoriahubDirs).toHaveLength(readManifest(join(PACKAGE_DIR, 'migrations')).migrations.length);
    expect(all.slice(-memoriahubDirs.length)).toEqual(memoriahubDirs); // the domain sorts after the platform's

    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      // The extension is created by the bootstrap superuser, never by the command or the migrations' role.
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      for (const dir of all) {
        try {
          await client.query(readFileSync(join(root, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
        } catch (error) {
          throw new Error(`${dir}: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.end();
    }

    const result = await checkMemoriahubInstall({ root, database: true, databaseUrl: url });
    expect(result.problems).toEqual([]);
  }, 180_000);

  it('builds the same domain schema as the web app history, which passes check --database with its real lock', async () => {
    const appDir = join(PACKAGE_DIR, '..', '..', 'apps', 'api');
    const migrations = join(appDir, 'prisma', 'migrations');
    const dirs = readdirSync(migrations).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(dirs.length).toBeGreaterThan(100);

    const client = new Client({ connectionString: historyUrl });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      for (const dir of dirs) {
        await client.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
      }
    } finally {
      await client.end();
    }

    const adopted = await checkMemoriahubInstall({ root: appDir, database: true, databaseUrl: historyUrl });
    expect(adopted.problems).toEqual([]);

    // @ts-ignore -- a plain .mjs script without declarations
    const { compareDomainSchema } = (await import('../../../scripts/memoriahub-packages/compare-domain-schema.mjs')) as {
      compareDomainSchema(a: PgClient, b: PgClient): Promise<{ equal: boolean; sections: { name: string; onlyA: string[]; onlyB: string[] }[] }>;
    };
    const a = new Client({ connectionString: historyUrl });
    const b = new Client({ connectionString: url });
    await a.connect();
    await b.connect();
    try {
      const compared = await compareDomainSchema(a, b);
      expect(compared.sections.flatMap((s) => [...s.onlyA.map((x) => `history only ${s.name}: ${x}`), ...s.onlyB.map((x) => `baseline only ${s.name}: ${x}`)])).toEqual([]);
      expect(compared.equal).toBe(true);
    } finally {
      await a.end();
      await b.end();
    }
  }, 300_000);

  it('fails check --database after a raw index is dropped', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('DROP INDEX faces_embedding_vec_hnsw_idx');
    } finally {
      await client.end();
    }
    const result = await checkMemoriahubInstall({ root, database: true, databaseUrl: url });
    expect(result.problems.map((p) => p.code)).toEqual(['INDEX_MISSING']);
    expect(result.problems[0]?.message).toContain('faces_embedding_vec_hnsw_idx');
  });
});
