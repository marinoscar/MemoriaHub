// =============================================================================
// Generate the seed's permission catalog (issue #676, PP-1.4)
// =============================================================================
//
// Writes `prisma/catalog/permissions.json` from the role and permission
// registries (`src/app-registrations`). `prisma/seed.ts` reads that file,
// because the seed runs inside the production image, which carries `dist/` and
// `prisma/` but no `src/`, so it cannot import the registries itself.
//
// Run with:  npm run catalog:permissions --workspace=api            (write)
//            npm run catalog:permissions --workspace=api -- --check (exit 1 if stale)
//
// `test/prisma/permission-catalog.spec.ts` runs the same comparison as
// `--check` in `npm test`, so a declaration changed without regenerating fails CI.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  PERMISSION_CATALOG_PATH,
  checkPermissionCatalog,
  renderPermissionCatalog,
} from '../src/app-registrations/permission-catalog';

function main(): number {
  const check = process.argv.includes('--check');
  const target = resolve(__dirname, '..', PERMISSION_CATALOG_PATH);

  if (check) {
    let committed: string | undefined;
    try {
      committed = readFileSync(target, 'utf8');
    } catch {
      committed = undefined;
    }
    const failure = checkPermissionCatalog(committed);
    if (failure === null) {
      console.log(`${PERMISSION_CATALOG_PATH} is up to date.`);
      return 0;
    }
    console.error(failure);
    return 1;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderPermissionCatalog());
  console.log(`Wrote ${PERMISSION_CATALOG_PATH}.`);
  return 0;
}

process.exitCode = main();
