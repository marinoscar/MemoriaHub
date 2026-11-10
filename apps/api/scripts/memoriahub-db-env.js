#!/usr/bin/env node
/**
 * memoriahub-db Environment Helper
 *
 * Runs the `memoriahub-db` command of @marinoscar/memoriahub-db with DATABASE_URL set,
 * built from the individual POSTGRES_* variables exactly the way
 * scripts/prisma-env.js and scripts/platform-env.js do it. Only the command
 * that touches a database needs it (`check --database`); the offline ones
 * (`sync`, `check`, `promote`) are wired straight to `memoriahub-db` in package.json.
 *
 * Usage:
 *   node scripts/memoriahub-db-env.js <memoriahub-db arguments>
 *
 * Example:
 *   node scripts/memoriahub-db-env.js check --database
 */

const { spawn } = require('child_process');
const path = require('path');

// Same URL formula as every other helper (requiring prisma-env.js is side-effect
// free apart from its dotenv load).
const { constructDatabaseUrl } = require('./prisma-env.js');

/** Resolves the `memoriahub-db` bin of the installed @marinoscar/memoriahub-db. */
function resolveMemoriahubDbBin() {
  const pkgJson = require.resolve('@marinoscar/memoriahub-db/package.json');
  return path.join(path.dirname(pkgJson), 'bin', 'memoriahub-db.js');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Error: No memoriahub-db command specified');
    console.error('Usage: node scripts/memoriahub-db-env.js <memoriahub-db arguments>');
    console.error('Example: node scripts/memoriahub-db-env.js check --database');
    process.exit(1);
  }

  const child = spawn(process.execPath, [resolveMemoriahubDbBin(), ...args], {
    env: { ...process.env, DATABASE_URL: constructDatabaseUrl() },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    process.exit(code === null ? (signal ? 1 : 0) : code);
  });

  child.on('error', (err) => {
    console.error('Failed to execute memoriahub-db:', err);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { resolveMemoriahubDbBin };
