#!/usr/bin/env node
/**
 * baseline-app-migrations.mjs - writes `appMigrations` into platform.lock
 * (RETRO-A5, issue #587).
 *
 * `platform db baseline` does not write `appMigrations`: the list of
 * MemoriaHub-only migration directories that `db:check` and `db:sync` use to
 * refuse an app migration that sorts before the last installed platform
 * migration (`APP_MIGRATION_OUT_OF_ORDER`). It is every directory under
 * prisma/migrations that platform.lock does not map to a package migration
 * (`migrations[].localDir`). Run once after the baseline; afterwards `db:sync`
 * maintains the list.
 *
 * Usage: node scripts/baseline-app-migrations.mjs [--lock <platform.lock>] [--migrations <dir>] [--check]
 *   --check  print the list and exit 1 when the lock's list differs; write nothing.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseLock, serializeLock } = require('@marinoscar/platform-db');

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const lockFile = resolve(opt('--lock', join(apiDir, 'prisma', 'platform.lock')));
const migrationsDir = resolve(opt('--migrations', join(apiDir, 'prisma', 'migrations')));
const check = argv.includes('--check');

if (!existsSync(lockFile)) {
  console.error(`baseline-app-migrations: ${lockFile} does not exist; run the baseline first`);
  process.exit(2);
}
const lock = parseLock(readFileSync(lockFile, 'utf8'), lockFile);
const mapped = new Set(lock.migrations.map((m) => m.localDir));
const appOnly = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !mapped.has(e.name) && existsSync(join(migrationsDir, e.name, 'migration.sql')))
  .map((e) => e.name)
  .sort();

if (check) {
  const same = JSON.stringify(lock.appMigrations ?? []) === JSON.stringify(appOnly);
  console.log(`baseline-app-migrations: ${appOnly.length} app-only directories; lock lists ${(lock.appMigrations ?? []).length}${same ? ' (match)' : ' (DIFFERENT)'}`);
  process.exit(same ? 0 : 1);
}
lock.appMigrations = appOnly;
writeFileSync(lockFile, serializeLock(lock));
console.log(`baseline-app-migrations: wrote ${appOnly.length} appMigrations to ${lockFile}`);
