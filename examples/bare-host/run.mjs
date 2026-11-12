#!/usr/bin/env node
// =============================================================================
// Bare host runner: proves the MemoriaHub packages work for a host outside the repository
// =============================================================================
//
// Copies examples/bare-host to a temporary folder OUTSIDE the repository, installs the
// packages there, and runs the checks. Nothing is published and no registry is needed for
// the MemoriaHub packages themselves: in `pack` mode they are installed from tarballs made
// with `npm pack` (what a registry would serve); their third-party dependencies come from the
// public npm registry like any install.
//
//   1. packs (or links) @marinoscar/memoriahub-{compute,contract,api}
//   2. installs them with the host's Nest and zod peers into the temporary project
//   3. asserts no @marinoscar/platform-* package and no provider SDK is in node_modules
//   4. typechecks the host with skipLibCheck: false (so the packages' .d.ts files are checked)
//   5. check-slice-peers --app <project>: the host lists every peer of the slices it imports
//   6. check-single-instance: one copy of every guarded package
//   7. builds and runs the host's tests (node --test)
//
// memoriahub-web is never installed (a headless host has no UI; the web app proves it).
// memoriahub-db is installed only with `--db postgres`. See README.md.
//
// Usage: node examples/bare-host/run.mjs [--from pack|workspace] [--db none|postgres] [--keep]
//   --from pack       install packed tarballs (default; what a consumer gets)
//   --from workspace  install copies of the workspace package folders
//   --db none         the slices run on the in-memory ports only (default)
//   --db postgres     ALSO install the packed @marinoscar/memoriahub-db and run its
//                     `check --database` (extensions, raw-SQL indexes, generated columns, CHECK
//                     constraints, function, triggers) against the PostgreSQL named by the
//                     BARE_HOST_DATABASE_URL environment variable, which must already hold the
//                     platform and domain migrations (CI: the API DB tier's database). The slices
//                     still run on the fake prisma client; PGlite is not used.
//   --keep            keep the temporary folder and print its path
// Needs: `npm run build:memoriahub-packages` first (at least compute, contract and api).
// Environment: ONNXRUNTIME_NODE_INSTALL=skip is set for the install (the host never loads onnx).
// Exit: 0 passed, 1 a check failed, 2 usage or setup error.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const INSTALLED = Object.freeze(['memoriahub-compute', 'memoriahub-contract', 'memoriahub-api']);
/** Packages that must not be in the host's node_modules. */
const ABSENT = Object.freeze([
  '@marinoscar/platform-api',
  '@marinoscar/platform-web',
  '@marinoscar/platform-contract',
  '@marinoscar/platform-db',
  '@marinoscar/platform-cli',
  '@marinoscar/platform-ai-providers',
  '@marinoscar/memoriahub-web',
  'openai',
  '@anthropic-ai/sdk',
]);

/** A failed check or a setup error; `main` prints it after the temporary folder is removed. */
class RunError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = 1) {
  throw new RunError(message, code);
}

function run(command, args, cwd, extraEnv = {}, quiet = false) {
  console.log(`bare-host: $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: 'skip', ...extraEnv },
  });
  if (result.stdout && !quiet) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (quiet && result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function parseArgs(argv) {
  const options = { from: 'pack', db: 'none', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--from') {
      options.from = argv[i + 1];
      i += 1;
    } else if (arg === '--db') {
      options.db = argv[i + 1];
      i += 1;
    } else fail(`unknown argument '${arg}'\nUsage: node examples/bare-host/run.mjs [--from pack|workspace] [--db none|postgres] [--keep]`, 2);
  }
  if (!['pack', 'workspace'].includes(options.from)) fail(`--from must be pack or workspace, got '${options.from}'`, 2);
  if (!['none', 'postgres'].includes(options.db)) fail(`--db must be none or postgres, got '${options.db}'`, 2);
  if (options.db === 'postgres') {
    const url = process.env.BARE_HOST_DATABASE_URL ?? '';
    if (!/^postgres(ql)?:\/\//.test(url)) fail('--db postgres needs BARE_HOST_DATABASE_URL set to a postgresql:// URL of a migrated database', 2);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const installed = options.db === 'postgres' ? [...INSTALLED, 'memoriahub-db'] : INSTALLED;
  for (const name of installed) {
    if (!existsSync(join(REPO, 'packages', name, 'dist'))) {
      fail(`packages/${name}/dist is missing. Build first: npm run build:memoriahub-packages`, 2);
    }
  }

  const work = mkdtempSync(join(tmpdir(), 'memoriahub-bare-host-'));
  if (realpathSync(work).startsWith(REPO + sep)) fail('the temporary folder is inside the repository; set TMPDIR elsewhere', 2);
  const tarballs = join(work, 'tarballs');
  const project = join(work, 'project');
  mkdirSync(tarballs);
  try {
    // 1. the packages
    const spec = {};
    for (const name of installed) {
      if (options.from === 'pack') {
        const out = run(NPM, ['pack', '-w', `@marinoscar/${name}`, '--pack-destination', tarballs, '--json'], REPO, {}, true);
        const filename = JSON.parse(out.stdout)[0].filename.replace(/^.*\//, '');
        spec[`@marinoscar/${name}`] = `file:${join(tarballs, filename)}`;
      } else {
        spec[`@marinoscar/${name}`] = `file:${join(REPO, 'packages', name)}`;
      }
    }

    // 2. the project: the host's sources, its manifest plus the packages
    mkdirSync(project);
    for (const entry of ['src', 'test', 'tsconfig.json']) cpSync(join(HERE, entry), join(project, entry), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
    manifest.dependencies = { ...spec, ...manifest.dependencies };
    writeFileSync(join(project, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const installArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
    if (options.from === 'workspace') installArgs.push('--install-links');
    run(NPM, installArgs, project);

    // 3. the host-neutral install
    const present = ABSENT.filter((name) => existsSync(join(project, 'node_modules', name)));
    if (present.length > 0) fail(`the bare host's node_modules holds ${present.join(', ')}; a package pulled in a platform package or a provider SDK`);
    console.log('bare-host: no platform package and no provider SDK in node_modules.');

    // 4 and 7. typecheck (skipLibCheck: false), build, run
    run(NPM, ['run', 'typecheck'], project);
    run(NPM, ['run', 'build'], project);
    run(NPM, ['test'], project);
    run(process.execPath, ['dist/src/main.js'], project);

    // 8. the database contract, from the packed memoriahub-db (--db postgres only)
    if (options.db === 'postgres') {
      // The installed copies live in the repository's API app (the database host of this repository), so
      // the check is the packed command over those copies and the live database; `pg` resolves from there.
      run(
        process.execPath,
        [join(project, 'node_modules', '@marinoscar', 'memoriahub-db', 'bin', 'memoriahub-db.js'), 'check', '--database', '--root', join(REPO, 'apps', 'api')],
        REPO,
        { DATABASE_URL: process.env.BARE_HOST_DATABASE_URL },
      );
    }

    // 5 and 6. the repository's own checks, pointed at the temporary project
    run(process.execPath, [join(REPO, 'scripts/memoriahub-packages/check-slice-peers.mjs'), '--root', REPO, '--app', project, '--without', 'local-reverse-geocoder'], REPO);
    // (--without: the bare host never selects the offline geocoder, so it leaves its optional peer out and
    //  really does not install it; the slice must still boot, which step 4 proves.)
    run(process.execPath, [join(REPO, 'scripts/memoriahub-packages/check-single-instance.mjs'), '--root', project, '--guard', '@marinoscar/platform-*', '--guard', '@marinoscar/memoriahub-*'], REPO);
  } finally {
    if (options.keep) console.log(`bare-host: kept ${relative(process.cwd(), work) || work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  console.log(`bare-host: passed (--from ${options.from}, --db ${options.db}).`);
}

try {
  main();
} catch (error) {
  console.error(`bare-host: ${error instanceof RunError ? error.message : error}`);
  process.exit(error instanceof RunError ? error.code : 2);
}
