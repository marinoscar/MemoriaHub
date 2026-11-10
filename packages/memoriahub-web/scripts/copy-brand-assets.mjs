#!/usr/bin/env node
// =============================================================================
// Copy the brand assets into dist/brand after the TypeScript build
// =============================================================================
//
// `tsc` emits only code. The PNG, ICO and SVG files of `src/brand/assets` are
// package exports (`@marinoscar/memoriahub-web/brand/assets/*`) that must exist
// next to the compiled `brand/index.js`, so the build ends by copying the folder
// into `dist/brand`.
//
// Usage: node scripts/copy-brand-assets.mjs
// Exit: 0 copied, 1 `dist/brand` missing (build first).
// Node built-ins only.
// =============================================================================

import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(PACKAGE_DIR, 'dist', 'brand');
if (!existsSync(target)) {
  console.error(`${target} does not exist; run the build first`);
  process.exit(1);
}
cpSync(join(PACKAGE_DIR, 'src', 'brand', 'assets'), join(target, 'assets'), { recursive: true });
console.log('Copied brand assets into dist/brand/assets');
