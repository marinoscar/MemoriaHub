#!/usr/bin/env node
// Classifies the web app's historic migrations (apps/api/prisma/migrations) by the tables they touch
// (RETRO-J3, #606): D (domain only), P (platform, legacy or app tables only), M (mixed), - (touches
// no table: an index or enum statement). The domain tables are the `@@map` names of
// packages/memoriahub-db/schema plus the tables the history created and later dropped. Output is a
// table, one migration per line; the result is recorded in docs/runbooks/memoriahub-domain-migration.md.
//
// Usage: node scripts/memoriahub-packages/classify-migrations.mjs [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = join(root, 'packages', 'memoriahub-db', 'schema');
const migrationsDir = join(root, 'apps', 'api', 'prisma', 'migrations');

const domain = new Set(['media_visual_embedding']);
for (const f of readdirSync(schemaDir)) {
  for (const m of readFileSync(join(schemaDir, f), 'utf8').matchAll(/@@map\("([a-z_]+)"\)/g)) domain.add(m[1]);
}
// Tables of the domain that the history created and later dropped (RETRO-I4, I5, K2 and the review-run rebuild).
for (const t of ['circles', 'circle_members', 'circle_invites', 'media_shares', 'location_suggestion_runs', 'location_suggestion_run_items']) domain.add(t);
domain.add('user_profiles'); // app-owned side table next to the domain; it never joins the package, but it is not platform either

const statement =
  /(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?(?: ONLY)?|DROP TABLE(?: IF EXISTS)?|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:UNIQUE )?INDEX [^\n]*? ON|DROP INDEX|CREATE POLICY [^\n]*? ON|CREATE TRIGGER [^\n]*? ON|REFERENCES|TRUNCATE(?: TABLE)?)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi;

const rows = [];
for (const dir of readdirSync(migrationsDir).sort()) {
  let sql;
  try {
    sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8');
  } catch {
    continue;
  }
  const tables = new Set([...sql.replace(/--[^\n]*/g, '').matchAll(statement)].map((m) => m[1].toLowerCase()));
  tables.delete('set');
  tables.delete('select');
  const dom = [...tables].filter((t) => domain.has(t)).sort();
  const other = [...tables].filter((t) => !domain.has(t)).sort();
  const kind = dom.length > 0 && other.length === 0 ? 'D' : other.length > 0 && dom.length === 0 ? 'P' : dom.length > 0 ? 'M' : '-';
  rows.push({ kind, dir, domain: dom, other });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  for (const r of rows) console.log(`${r.kind} ${r.dir}  domain: ${r.domain.join(',')}  other: ${r.other.join(',')}`);
  const count = (k) => rows.filter((r) => r.kind === k).length;
  console.log(`\n${rows.length} migrations: ${count('D')} domain only, ${count('P')} platform/legacy/app only, ${count('M')} mixed, ${count('-')} no table`);
}
