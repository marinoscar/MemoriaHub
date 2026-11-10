#!/usr/bin/env node
// =============================================================================
// Lean-install smoke for @marinoscar/memoriahub-compute and -contract (issue #593, #598)
// =============================================================================
//
// memoriahub-compute is installed by a worker node (and the API image) with no
// platform and no AI provider SDK. A source-level rule (check-slice-peers,
// rule 6) guards the imports; this script guards the INSTALL: it packs the
// package, installs the tarball into an empty temporary project and asserts:
//
//   1. No @marinoscar/platform-* package and no provider SDK (`openai`,
//      `@anthropic-ai/sdk`) is in the installed tree (`npm ls --all` and the
//      node_modules folder). If that ever stops being true it is a finding, not
//      something to relax: provider SDKs live only in
//      @marinoscar/platform-ai-providers, and a node never holds a provider key.
//   2. The packages load through BOTH exports conditions (require and import)
//      and a pure function works (dHash Hamming distance; a contract schema
//      parser exists). The contract is installed beside compute and brings only
//      its zod peer.
//
// Needs: `npm run build:memoriahub-packages` first, and the npm registry for the
// package's own dependencies (sharp, onnxruntime-node, exifr, zod); the tarball
// is local.
//
// Usage: node scripts/memoriahub-packages/check-lean-install.mjs [--keep]
// Exit: 0 clean, 1 violation, 2 usage or setup error.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The workspace packages the smoke installs. */
export const PACKED = Object.freeze(['memoriahub-compute', 'memoriahub-contract']);
/** Packages that must NOT appear anywhere in the installed tree. */
export const FORBIDDEN_PACKAGES = Object.freeze([
  '@marinoscar/platform-api',
  '@marinoscar/platform-contract',
  '@marinoscar/platform-cli',
  '@marinoscar/platform-ai-providers',
  'openai',
  '@anthropic-ai/sdk',
]);

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Every INSTALLED package name in an `npm ls --all --json` tree (nested
 * `dependencies`). An unmet optional peer is listed without a `version` and is not
 * installed, so it does not count.
 */
export function treeNames(node, out = new Set()) {
  for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
    if (child?.version !== undefined) out.add(name);
    treeNames(child, out);
  }
  return out;
}

/** The forbidden packages present in a name set. */
export function forbiddenIn(names) {
  return FORBIDDEN_PACKAGES.filter((name) => names.has(name));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });
  if (options.allowFail !== true && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

/** The smoke program run inside the temporary project. */
const SMOKE = `
const assert = require('node:assert/strict');
const cjs = require('@marinoscar/memoriahub-compute/dhash');
assert.equal(typeof cjs.hammingDistance, 'function', 'require() condition');
const contract = require('@marinoscar/memoriahub-contract/media');
assert.equal(typeof contract.mediaQuerySchema.parse, 'function', 'contract require() condition');
Promise.all([import('@marinoscar/memoriahub-compute/dhash'), import('@marinoscar/memoriahub-contract')]).then(([esm, contractEsm]) => {
  assert.equal(typeof esm.hammingDistance, 'function', 'import condition');
  assert.equal(esm.hammingDistance('0', '0'), 0);
  assert.equal(typeof contractEsm.mediaQuerySchema.parse, 'function', 'contract import condition');
  assert.throws(() => require.resolve('@marinoscar/memoriahub-compute/ai'), /./, 'the removed ./ai subpath must not resolve');
  console.log('lean-install smoke: ok');
}).catch((error) => { console.error(error); process.exit(1); });
`;

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const unknown = argv.filter((a) => a !== '--keep');
  if (unknown.length > 0) {
    console.error(`check-lean-install: unknown argument '${unknown[0]}'\nUsage: node scripts/memoriahub-packages/check-lean-install.mjs [--keep]`);
    process.exit(2);
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const name of PACKED) {
    if (!existsSync(join(repo, 'packages', name, 'dist'))) {
      console.error(`check-lean-install: packages/${name}/dist is missing. Build first: npm run build:memoriahub-packages`);
      process.exit(2);
    }
  }

  const work = mkdtempSync(join(tmpdir(), 'memoriahub-lean-install-'));
  const tarballs = join(work, 'tarballs');
  const app = join(work, 'app');
  mkdirSync(tarballs);
  mkdirSync(app);
  let failed = false;
  try {
    const files = {};
    for (const name of PACKED) {
      const out = run(NPM, ['pack', '-w', `@marinoscar/${name}`, '--pack-destination', tarballs, '--json'], { cwd: repo });
      files[name] = join(tarballs, JSON.parse(out.stdout)[0].filename.replace(/^.*\//, ''));
    }
    const dependencies = {
      '@marinoscar/memoriahub-compute': `file:${files['memoriahub-compute']}`,
      '@marinoscar/memoriahub-contract': `file:${files['memoriahub-contract']}`,
    };
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'lean-install-smoke', version: '0.0.0', private: true, dependencies }, null, 2));
    console.log('check-lean-install: npm install (packed tarballs + peers only)');
    run(NPM, ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app });

    const ls = run(NPM, ['ls', '--all', '--json'], { cwd: app, allowFail: true });
    const names = treeNames(JSON.parse(ls.stdout || '{}'));
    const onDisk = FORBIDDEN_PACKAGES.filter((name) => existsSync(join(app, 'node_modules', name)));
    const present = [...new Set([...forbiddenIn(names), ...onDisk])];
    if (present.length > 0) {
      failed = true;
      console.error(`check-lean-install: FAILED. The lean install pulled in ${present.join(', ')}.`);
      const why = run(NPM, ['explain', present[0]], { cwd: app, allowFail: true });
      console.error(why.stdout || why.stderr);
    } else {
      console.log('check-lean-install: no platform package and no provider SDK in the tree.');
    }

    writeFileSync(join(app, 'smoke.cjs'), SMOKE);
    const smoke = run(process.execPath, ['smoke.cjs'], { cwd: app, allowFail: true });
    process.stdout.write(smoke.stdout ?? '');
    if (smoke.status !== 0) {
      failed = true;
      console.error(smoke.stderr);
    }
  } catch (error) {
    console.error(`check-lean-install: ${error.message}`);
    process.exitCode = 2;
    return;
  } finally {
    if (keep) console.log(`check-lean-install: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('check-lean-install: passed.');
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();
