/**
 * Patches react-transition-group's package.json to add an `exports` map.
 *
 * WHY THIS IS NEEDED:
 * react-transition-group v4.x ships without a package `exports` field.  When
 * MUI v9's ESM entry files (*.mjs) run under Node's native ESM loader they
 * import bare subpath specifiers such as
 *   import TransitionGroupContext from 'react-transition-group/TransitionGroupContext'
 * Node's native ESM resolver treats these as directory imports, which are
 * forbidden in ESM and throw:
 *   "Directory import … is not supported resolving ES modules"
 *
 * The fix: inject a minimal `exports` map that resolves every known subpath to
 * the package's CJS file.  CJS is preferred here (over ESM) to guarantee a
 * single React instance in the Vitest jsdom test environment.
 *
 * This script is idempotent – it only writes when the patch has not yet been
 * applied.
 */

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(
  __dirname,
  '../node_modules/react-transition-group/package.json',
);

if (!fs.existsSync(pkgPath)) {
  // Package not installed (e.g. CI workspace filtered install) – nothing to do.
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (pkg.exports) {
  // Already patched – skip.
  process.exit(0);
}

const subpaths = [
  'CSSTransition',
  'ReplaceTransition',
  'SwitchTransition',
  'Transition',
  'TransitionGroup',
  'TransitionGroupContext',
  'config',
];

pkg.exports = {
  '.': { require: './cjs/index.js', default: './cjs/index.js' },
  // Some call sites (e.g. MUI's own internals, some test utilities) import
  // the deep cjs path directly rather than the bare subpath name. Since
  // defining `exports` makes resolution EXCLUSIVE — any path not listed here
  // becomes forbidden, even ones that resolved fine before this field existed
  // — a wildcard for the whole cjs/ directory is required, not just the named
  // subpaths below.
  './cjs/*.js': './cjs/*.js',
  './package.json': './package.json',
};
for (const s of subpaths) {
  pkg.exports[`./${s}`] = {
    require: `./cjs/${s}.js`,
    default: `./cjs/${s}.js`,
  };
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('react-transition-group exports patched successfully.');
