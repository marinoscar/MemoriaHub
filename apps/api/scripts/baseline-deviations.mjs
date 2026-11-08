#!/usr/bin/env node
/**
 * baseline-deviations.mjs - TEMPORARY tooling for the platform baseline
 * (RETRO-A5, issue #587). Removed together with the last deviation (RETRO-B2).
 *
 * `platform db baseline --through 2` diffs the platform history up to `0002`
 * against the live database (B3) and prints every statement the database has
 * that the platform history does not, as `BLOCKING:` lines. For MemoriaHub
 * that is (a) every domain object the app-only migrations created (including
 * the `mh_legacy_*` objects the A5 rename migration produced) and (b) the four
 * avatar columns MemoriaHub added to `users`. Pasting ~400 statements into
 * `platform.lock` by hand would be an unverifiable act of faith, so this script
 * reads a SAVED dry-run report and proves each statement before it will turn it
 * into a `deviations` entry:
 *
 *   - `memoriahub:users-avatar`: the ONLY thing that may touch a platform
 *     table. Exactly `users.avatar_source`, `avatar_storage_key`,
 *     `avatar_version`, `linked_person_id`, the index on `linked_person_id` and
 *     the foreign key `users_linked_person_id_fkey`; each column must be added
 *     by an app-only migration.
 *   - `memoriahub:legacy-platform-tables`: statements about a `mh_legacy_*`
 *     table or `MhLegacy*` enum. The object is accepted when its ORIGINAL name
 *     (prefix removed) was created by an app-only migration, i.e. the A5 rename
 *     migration only moved a MemoriaHub-owned object out of the platform's way.
 *   - `memoriahub:domain-schema`: every other statement, accepted only when it
 *     targets a table or enum type an app-only migration CREATEs. A foreign key
 *     FROM a domain table TO a platform table is fine (it alters the domain
 *     table).
 *   - anything else (an index, column, constraint or drop on a platform
 *     `0001`/`0002` table that is not the avatar set, e.g. a seeded
 *     `users.email` change) is a REAL difference: exit 1, print it, stop.
 *
 * "App-only" directories are every directory under the migrations folder that
 * the report does not show as matched to a platform migration (the report's
 * `app-only:` lines can omit a directory that was hidden from the tool, see
 * docs/runbooks/database-baseline.md section "Hiding push_subscriptions").
 *
 * Usage:
 *   node scripts/baseline-deviations.mjs <report.txt> [--migrations <dir>]
 *                                        [--lock <platform.lock> --write]
 *
 * Exit codes: 0 all statements proven, 1 a statement was refused, 2 usage error.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const AVATAR_ID = 'memoriahub:users-avatar';
export const LEGACY_ID = 'memoriahub:legacy-platform-tables';
export const DOMAIN_ID = 'memoriahub:domain-schema';

/** The only objects a platform table (`0001`/`0002`) may differ by. */
export const AVATAR_TABLE = 'users';
export const AVATAR_COLUMNS = ['avatar_source', 'avatar_storage_key', 'avatar_version', 'linked_person_id'];
export const AVATAR_INDEX = 'users_linked_person_id_idx';
export const AVATAR_FK = 'users_linked_person_id_fkey';

const LEGACY_TABLE_PREFIX = 'mh_legacy_';
const LEGACY_TYPE_PREFIX = 'MhLegacy';

const REASONS = {
  [AVATAR_ID]:
    'MemoriaHub-only columns users.avatar_source, avatar_storage_key, avatar_version, linked_person_id, their index and users_linked_person_id_fkey (migration 20260810010000_add_user_avatar_source_and_person_link). Temporary: RETRO-B2 moves them off users and removes this entry.',
  [LEGACY_ID]:
    'MemoriaHub tables and enums that collide with platform migrations 0003-0040, renamed to mh_legacy_* / MhLegacy* by 20260817000000_rename_legacy_platform_tables. Removed piecewise by RETRO-C1 (jobs), C2 (worker nodes), D3 (notifications), D4 (database backups), D5 (android releases) as each slice moves its data and drops its legacy table.',
  [DOMAIN_ID]:
    'MemoriaHub domain tables and enums created by app-only migrations; not a change to a platform table. A permanent record of what the app owns.',
};

/** Same normalisation the baseline applies before comparing a statement to `expectDiff`. */
export function normaliseStatement(statement) {
  return statement.replace(/"public"\./g, '').replace(/\s+/g, ' ').trim();
}

/** The `BLOCKING:` statements of a saved dry-run report, in report order. */
export function parseBlockingStatements(report) {
  return report
    .split(/\r?\n/)
    .filter((l) => /^\s*BLOCKING:\s/.test(l))
    .map((l) => normaliseStatement(l.replace(/^\s*BLOCKING:\s*/, '')));
}

/** The migration directories the report shows as matched to a platform migration (`platform:NNNN -> dir [kind]`). */
export function parseMatchedDirectories(report) {
  return report
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*platform:\S+\s+->\s+(\d{6,}\S*)\s+\[/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';

/**
 * What the app-only migrations create and which columns they add.
 *
 * @param {Array<[string, string]>} migrations `[directory, sql]` of the app-only migrations.
 */
export function collectAppObjects(migrations) {
  const tables = new Set();
  const types = new Set();
  const addedColumns = new Set(); // `table.column`
  for (const [, rawSql] of migrations) {
    const sql = stripSqlComments(rawSql);
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?${IDENT}`, 'gi'))) {
      tables.add(m[1]);
    }
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TYPE\\s+(?:"?public"?\\.)?${IDENT}`, 'gi'))) {
      types.add(m[1]);
    }
    for (const stmt of sql.split(';')) {
      const alter = stmt.match(new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:"?public"?\\.)?${IDENT}\\s+([\\s\\S]*)$`, 'i'));
      if (!alter) continue;
      for (const col of alter[2].matchAll(new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        addedColumns.add(`${alter[1]}.${col[1]}`);
      }
    }
  }
  return { tables, types, addedColumns };
}

/** The table or type a statement is about, or `null` for a shape `prisma migrate diff` does not print for an added object. */
export function statementTarget(statement) {
  const patterns = [
    [new RegExp(`^CREATE TYPE ${IDENT}\\b`, 'i'), 'type'],
    [new RegExp(`^CREATE TABLE ${IDENT}\\b`, 'i'), 'table'],
    [new RegExp(`^ALTER TABLE ${IDENT}\\b`, 'i'), 'table'],
    [new RegExp(`^CREATE (?:UNIQUE )?INDEX ${IDENT} ON ${IDENT}\\b`, 'i'), 'index'],
  ];
  for (const [re, kind] of patterns) {
    const m = statement.match(re);
    if (m) return { kind, name: kind === 'index' ? m[2] : m[1], index: kind === 'index' ? m[1] : null };
  }
  return null;
}

/** True when `statement` is exactly the avatar part of `users`: the four ADD COLUMNs, the index, or the foreign key. */
function isAvatarStatement(statement, target, addedColumns) {
  if (target.name !== AVATAR_TABLE) return false;
  if (target.kind === 'index') return target.index === AVATAR_INDEX;
  if (target.kind !== 'table') return false;
  const fk = statement.match(new RegExp(`^ALTER TABLE ${IDENT} ADD CONSTRAINT ${IDENT} FOREIGN KEY`, 'i'));
  if (fk) return fk[2] === AVATAR_FK;
  const body = statement.replace(new RegExp(`^ALTER TABLE ${IDENT}\\s+`, 'i'), '').replace(/;$/, '');
  const clauses = body.split(/,\s*(?=ADD COLUMN\b)/i);
  for (const clause of clauses) {
    const m = clause.match(new RegExp(`^ADD COLUMN ${IDENT}\\s`, 'i'));
    if (!m || !AVATAR_COLUMNS.includes(m[1]) || !addedColumns.has(`${AVATAR_TABLE}.${m[1]}`)) return false;
  }
  return clauses.length > 0;
}

/** `{ legacy, original }` when a table/type name is an A5 legacy name, else `{ legacy: false, original: name }`. */
export function originalName(kind, name) {
  if (kind === 'type' && name.startsWith(LEGACY_TYPE_PREFIX)) return { legacy: true, original: name.slice(LEGACY_TYPE_PREFIX.length) };
  if (kind !== 'type' && name.startsWith(LEGACY_TABLE_PREFIX)) return { legacy: true, original: name.slice(LEGACY_TABLE_PREFIX.length) };
  return { legacy: false, original: name };
}

/**
 * Classifies every statement.
 *
 * @returns `{ entries, refused }`: `entries` maps deviation id to its statements;
 *   `refused` lists `{ statement, why }` for every statement that is not proven.
 */
export function classify(statements, appObjects) {
  const entries = { [AVATAR_ID]: [], [LEGACY_ID]: [], [DOMAIN_ID]: [] };
  const refused = [];
  for (const statement of statements) {
    const target = statementTarget(statement);
    if (!target) {
      refused.push({ statement, why: 'not a statement shape that creates or alters a MemoriaHub domain object' });
      continue;
    }
    // 1. The avatar part of `users` is the only thing that may touch a platform table.
    if (target.name === AVATAR_TABLE) {
      if (isAvatarStatement(statement, target, appObjects.addedColumns)) entries[AVATAR_ID].push(statement);
      else {
        refused.push({
          statement,
          why: `touches platform table "users" and is not one of ${AVATAR_COLUMNS.join(' / ')}, ${AVATAR_INDEX} or ${AVATAR_FK} added by an app-only migration`,
        });
      }
      continue;
    }
    // 2. Everything else must belong to a table or enum an app-only migration creates (after undoing the A5 rename).
    const kind = target.kind === 'type' ? 'type' : 'table';
    const { legacy, original } = originalName(kind, target.name);
    const known = kind === 'type' ? appObjects.types.has(original) : appObjects.tables.has(original);
    if (!known) {
      refused.push({
        statement,
        why: `"${target.name}" is not a table or type created by an app-only migration, so this is a platform object: a real difference`,
      });
      continue;
    }
    entries[legacy ? LEGACY_ID : DOMAIN_ID].push(statement);
  }
  return { entries, refused };
}

/** The `deviations` entries; empty entries are omitted. */
export function buildDeviations(entries) {
  return [AVATAR_ID, LEGACY_ID, DOMAIN_ID]
    .filter((id) => entries[id].length > 0)
    .map((id) => ({ id, reason: REASONS[id], expectDiff: entries[id] }));
}

function appOnlyDirectories(migrationsDir, matched) {
  const skip = new Set(matched);
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !skip.has(e.name) && existsSync(join(migrationsDir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort();
}

function parseArgs(argv) {
  const args = { report: null, migrations: null, lock: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--migrations') args.migrations = argv[++i];
    else if (a === '--lock') args.lock = argv[++i];
    else if (a === '--write') args.write = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.report) args.report = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.report) throw new Error('missing <report.txt>');
  if (args.write && !args.lock) throw new Error('--write needs --lock <platform.lock>');
  return args;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err.write(`baseline-deviations: ${e.message}\n`);
    err.write('Usage: node scripts/baseline-deviations.mjs <report.txt> [--migrations <dir>] [--lock <platform.lock> --write]\n');
    return 2;
  }
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const migrationsDir = resolve(args.migrations ?? join(apiDir, 'prisma', 'migrations'));
  const report = readFileSync(args.report, 'utf8');
  const statements = parseBlockingStatements(report);
  if (statements.length === 0) {
    err.write('baseline-deviations: the report has no BLOCKING statements; nothing to declare (save the output of a dry run: db:baseline -- --through 2)\n');
    return 2;
  }
  const matched = parseMatchedDirectories(report);
  const appOnly = appOnlyDirectories(migrationsDir, matched);
  const appObjects = collectAppObjects(appOnly.map((d) => [d, readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8')]));
  const { entries, refused } = classify(statements, appObjects);

  if (refused.length > 0) {
    err.write(`baseline-deviations: REFUSED ${refused.length} statement(s). They are real differences between the database and the platform history; do not declare them. Report them on the issue.\n`);
    for (const r of refused) err.write(`  - ${r.why}\n      ${r.statement}\n`);
    return 1;
  }

  const deviations = buildDeviations(entries);
  const counts = deviations.map((d) => `${d.id}: ${d.expectDiff.length}`).join(', ');
  err.write(`baseline-deviations: ${statements.length} statement(s) proven (${counts})\n`);

  if (args.write) {
    const { parseLock, serializeLock, emptyLock } = require('@marinoscar/platform-db');
    const lockFile = resolve(args.lock);
    const lock = existsSync(lockFile) ? parseLock(readFileSync(lockFile, 'utf8'), lockFile) : emptyLock();
    const ids = new Set(deviations.map((d) => d.id));
    lock.deviations = [...(lock.deviations ?? []).filter((d) => !ids.has(d.id)), ...deviations];
    writeFileSync(lockFile, serializeLock(lock));
    err.write(`baseline-deviations: wrote ${deviations.length} deviation(s) to ${lockFile}\n`);
  } else {
    out.write(`${JSON.stringify(deviations, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
