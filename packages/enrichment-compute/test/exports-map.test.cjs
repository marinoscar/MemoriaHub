/**
 * Smoke test for the package.json "exports" map's CJS ("require") condition.
 *
 * The package is authored as ESM (`"type": "module"`) but ships a parallel
 * CJS build (dist/cjs) so apps/api and apps/cli — whichever module system
 * they run under — resolve identically. This test spawns a plain `node -e`
 * process (not `node --test`, since this file itself must stay CJS to
 * exercise `require()`) that calls `require('@memoriahub/enrichment-compute/dhash')`
 * and asserts the expected named exports come back, proving the "require"
 * condition in the exports map actually resolves and loads.
 */

const test = require('node:test').test;
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('require("@memoriahub/enrichment-compute/dhash") works via the CJS exports condition', () => {
  // Run from the worktree root so node resolves the package via the npm
  // workspace symlink (node_modules/@memoriahub/enrichment-compute ->
  // ../../packages/enrichment-compute), exercising the real exports map
  // exactly as a consumer (apps/api, apps/cli) would.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const m = require('@memoriahub/enrichment-compute/dhash'); " +
        "if (typeof m.computeDHash !== 'function') throw new Error('computeDHash missing'); " +
        "if (typeof m.hammingDistance !== 'function') throw new Error('hammingDistance missing'); " +
        "console.log('OK');",
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `require() smoke script failed: ${result.stderr}`);
  assert.match(result.stdout, /OK/);
});
