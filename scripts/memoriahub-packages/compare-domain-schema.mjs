#!/usr/bin/env node
// Compares what the memoriahub-db domain owns in two databases (RETRO-J3, #606): every domain table's
// columns (type, nullability, default, generation), constraints, indexes, triggers, row-level-security
// flags and policies, plus the domain enums and functions. Column ORDER is ignored (a history that
// ALTERs a table and a baseline that CREATEs it differ there and nowhere else). Exit 0 when equal.
//
// Usage: node scripts/memoriahub-packages/compare-domain-schema.mjs <postgres-url-A> <postgres-url-B>
// As a module: `compareDomainSchema(clientA, clientB)` takes two connected `pg` clients and returns
// { sections: [{ name, count: [a, b], onlyA, onlyB }], equal }.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', '..', 'packages', 'memoriahub-db', 'schema');

/** The tables the domain owns: every `@@map` of the package fragments, plus the table Prisma cannot model. */
export function domainTables() {
  const tables = new Set(['media_visual_embedding']);
  for (const f of readdirSync(schemaDir)) {
    for (const m of readFileSync(join(schemaDir, f), 'utf8').matchAll(/@@map\("([a-z_]+)"\)/g)) tables.add(m[1]);
  }
  return [...tables].sort();
}

const list = domainTables().map((t) => `'${t}'`).join(',');

const queries = {
  columns: `SELECT c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END||COALESCE(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),'')||CASE WHEN a.attgenerated<>'' THEN ' GENERATED' ELSE '' END
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${list}) AND a.attnum>0 AND NOT a.attisdropped`,
  constraints: `SELECT c.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relname IN (${list}) AND c.relnamespace='public'::regnamespace`,
  indexes: `SELECT tablename||' '||indexname||' '||indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN (${list})`,
  triggers: `SELECT c.relname||' '||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN (${list})`,
  rls: `SELECT relname||' rls='||relrowsecurity||' force='||relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN (${list})`,
  policies: `SELECT tablename||' '||policyname||' '||cmd||' '||permissive||' '||COALESCE(qual,'')||' | '||COALESCE(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename IN (${list})`,
  enums: `SELECT t.typname||' '||string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typnamespace='public'::regnamespace AND t.typname IN (
      SELECT DISTINCT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${list})) GROUP BY t.typname`,
  functions: `SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('mh_default_org_id','face_embedding_to_vector','faces_sync_embedding_vec','mh_content_owner_from_scope')`,
};

/** Reads one section of the domain schema from a connected `pg` client, sorted (functions are one text). */
async function section(client, name) {
  const { rows } = await client.query(queries[name]);
  const lines = rows.map((r) => String(Object.values(r)[0]).trimEnd());
  return name === 'functions' ? [lines.sort().join('\n')] : lines.sort();
}

export async function compareDomainSchema(clientA, clientB) {
  const sections = [];
  for (const name of Object.keys(queries)) {
    const a = await section(clientA, name);
    const b = await section(clientB, name);
    const sa = new Set(a);
    const sb = new Set(b);
    sections.push({ name, count: [a.length, b.length], onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) });
  }
  return { sections, equal: sections.every((s) => s.onlyA.length + s.onlyB.length === 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [urlA, urlB] = process.argv.slice(2);
  if (!urlA || !urlB) {
    console.error('usage: compare-domain-schema.mjs <postgres-url-A> <postgres-url-B>');
    process.exit(2);
  }
  const { Client } = createRequire(import.meta.url)('pg');
  const a = new Client({ connectionString: urlA });
  const b = new Client({ connectionString: urlB });
  await a.connect();
  await b.connect();
  const result = await compareDomainSchema(a, b);
  await a.end();
  await b.end();
  for (const s of result.sections) {
    console.log(`${s.name.padEnd(12)} ${s.count[0]} vs ${s.count[1]}  ${s.onlyA.length + s.onlyB.length === 0 ? 'equal' : 'DIFFERENT'}`);
    for (const x of s.onlyA) console.log(`  only in A: ${x}`);
    for (const x of s.onlyB) console.log(`  only in B: ${x}`);
  }
  process.exit(result.equal ? 0 : 1);
}
