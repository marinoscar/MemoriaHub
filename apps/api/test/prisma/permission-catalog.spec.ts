import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PERMISSION_CATALOG_PATH,
  checkPermissionCatalog,
} from '../../src/app-registrations/permission-catalog';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { permissionRegistry } from '@marinoscar/platform-api/core';

import '../../src/app-registrations/permission-manifest';

// The committed seed catalog is what the registries render now (RETRO-B2, #611),
// and every permission constant the controllers use is a registered permission.
describe('permission catalog', () => {
  it('prisma/catalog/permissions.json is current', () => {
    const committed = readFileSync(join(__dirname, '..', '..', PERMISSION_CATALOG_PATH), 'utf8');
    expect(checkPermissionCatalog(committed)).toBeNull();
  });

  it('every PERMISSIONS constant is a registered permission', () => {
    const registered = new Set(permissionRegistry.list().map((permission) => permission.id));
    for (const [name, id] of Object.entries(PERMISSIONS)) {
      expect({ name, registered: registered.has(id) }).toEqual({ name, registered: true });
    }
  });
});
