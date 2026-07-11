/**
 * Writes the two per-format stub package.json files after both tsc passes.
 *
 * The package root declares `"type": "module"`, so without these stubs Node
 * would treat dist/cjs/*.js as ESM. The stub in dist/cjs flips the format
 * back to CommonJS for that subtree; the dist/esm stub is explicit
 * documentation of the intended format.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const stubs = [
  [join(pkgRoot, 'dist/cjs/package.json'), { type: 'commonjs' }],
  [join(pkgRoot, 'dist/esm/package.json'), { type: 'module' }],
];

for (const [path, content] of stubs) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content) + '\n');
}
