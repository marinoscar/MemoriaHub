import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacReconcileService } from './rbac-reconcile.service';
import { PERMISSION_CATALOG, ROLE_PERMISSION_MATRIX } from '../constants/rbac.catalog';

type MockPrisma = {
  permission: {
    findMany: jest.Mock;
    createMany: jest.Mock;
    update: jest.Mock;
  };
  role: { findMany: jest.Mock };
  rolePermission: {
    findMany: jest.Mock;
    createMany: jest.Mock;
  };
};

const ROLE_IDS: Record<string, string> = {
  admin: 'role-admin',
  contributor: 'role-contributor',
  viewer: 'role-viewer',
};

/** A database already holding the full catalog and every catalogued grant. */
function fullyInSyncState() {
  const permissions = PERMISSION_CATALOG.map((p) => ({
    id: `perm-${p.name}`,
    name: p.name as string,
    description: p.description,
  }));

  const grants = Object.entries(ROLE_PERMISSION_MATRIX).flatMap(([roleName, names]) =>
    names.map((name) => ({ roleId: ROLE_IDS[roleName], permissionId: `perm-${name}` })),
  );

  return { permissions, grants };
}

describe('RbacReconcileService', () => {
  let service: RbacReconcileService;
  let prisma: MockPrisma;

  /** Wires the mock to report `permissions`/`grants` as the current DB state. */
  function seedMockState(
    permissions: Array<{ id: string; name: string; description: string }>,
    grants: Array<{ roleId: string; permissionId: string }>,
  ) {
    prisma.permission.findMany.mockResolvedValue(permissions);
    prisma.rolePermission.findMany.mockResolvedValue(grants);
    prisma.role.findMany.mockResolvedValue(
      Object.entries(ROLE_IDS).map(([name, id]) => ({ id, name })),
    );
  }

  beforeEach(async () => {
    prisma = {
      permission: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockImplementation(({ data }) => ({ count: data.length })),
        update: jest.fn().mockResolvedValue({}),
      },
      role: { findMany: jest.fn().mockResolvedValue([]) },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockImplementation(({ data }) => ({ count: data.length })),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RbacReconcileService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<RbacReconcileService>(RbacReconcileService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  describe('on an empty database', () => {
    it('creates every catalogued permission', async () => {
      await service.reconcile();

      expect(prisma.permission.createMany).toHaveBeenCalledTimes(1);
      const created = prisma.permission.createMany.mock.calls[0][0].data;
      expect(created.map((p: { name: string }) => p.name).sort()).toEqual(
        PERMISSION_CATALOG.map((p) => p.name as string).sort(),
      );
    });

    it('uses skipDuplicates so a concurrent boot cannot collide', async () => {
      await service.reconcile();

      expect(prisma.permission.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });
  });

  describe('when the catalog is already fully applied', () => {
    beforeEach(() => {
      const { permissions, grants } = fullyInSyncState();
      seedMockState(permissions, grants);
    });

    it('writes nothing', async () => {
      const result = await service.reconcile();

      expect(result).toEqual({
        permissionsCreated: 0,
        descriptionsUpdated: 0,
        grantsCreated: 0,
      });
      expect(prisma.permission.createMany).not.toHaveBeenCalled();
      expect(prisma.permission.update).not.toHaveBeenCalled();
      expect(prisma.rolePermission.createMany).not.toHaveBeenCalled();
    });
  });

  describe('the #293 scenario: a permission is missing from an existing install', () => {
    beforeEach(() => {
      const { permissions, grants } = fullyInSyncState();

      // Reproduce production: every permission present EXCEPT email_settings:*,
      // and no grants for them either.
      const withoutEmail = permissions.filter((p) => !p.name.startsWith('email_settings:'));
      const grantsWithoutEmail = grants.filter(
        (g) => !g.permissionId.startsWith('perm-email_settings:'),
      );

      seedMockState(withoutEmail, grantsWithoutEmail);

      // After the insert, the rows exist — reflect that for the grant pass.
      prisma.permission.findMany
        .mockResolvedValueOnce(withoutEmail) // reconcilePermissions
        .mockResolvedValueOnce(withoutEmail) // reconcileDescriptions
        .mockResolvedValue(permissions); // reconcileRoleGrants
    });

    it('creates exactly the two missing email_settings permissions', async () => {
      await service.reconcile();

      const created = prisma.permission.createMany.mock.calls[0][0].data;
      expect(created.map((p: { name: string }) => p.name).sort()).toEqual([
        'email_settings:read',
        'email_settings:write',
      ]);
    });

    it('grants both to the admin role', async () => {
      await service.reconcile();

      const grants = prisma.rolePermission.createMany.mock.calls[0][0].data;
      expect(grants).toEqual(
        expect.arrayContaining([
          { roleId: ROLE_IDS.admin, permissionId: 'perm-email_settings:read' },
          { roleId: ROLE_IDS.admin, permissionId: 'perm-email_settings:write' },
        ]),
      );
    });

    it('grants them to admin only, not to contributor or viewer', async () => {
      await service.reconcile();

      const grants = prisma.rolePermission.createMany.mock.calls[0][0].data;
      const nonAdmin = grants.filter(
        (g: { roleId: string }) => g.roleId !== ROLE_IDS.admin,
      );
      expect(nonAdmin).toEqual([]);
    });
  });

  describe('additive-only guarantee', () => {
    it('never revokes a grant that is absent from the catalog', async () => {
      const { permissions, grants } = fullyInSyncState();

      // A grant nobody catalogues — e.g. left over from a removed feature.
      const strayGrant = { roleId: ROLE_IDS.viewer, permissionId: 'perm-jobs:write' };
      seedMockState(permissions, [...grants, strayGrant]);

      const result = await service.reconcile();

      // The stray grant is left exactly as-is: nothing written, nothing removed.
      expect(prisma.rolePermission.createMany).not.toHaveBeenCalled();
      expect(result.grantsCreated).toBe(0);
    });

    it('updates a stale description rather than recreating the row', async () => {
      const { permissions, grants } = fullyInSyncState();
      const stale = permissions.map((p, i) =>
        i === 0 ? { ...p, description: 'outdated text' } : p,
      );

      seedMockState(stale, grants);

      const result = await service.reconcile();

      expect(result.descriptionsUpdated).toBe(1);
      expect(prisma.permission.update).toHaveBeenCalledWith({
        where: { name: permissions[0].name },
        data: { description: permissions[0].description },
      });
      expect(prisma.permission.createMany).not.toHaveBeenCalled();
    });
  });

  describe('failure handling at boot', () => {
    it('does not throw out of onModuleInit when the database is unreachable', async () => {
      prisma.permission.findMany.mockRejectedValue(new Error('connection refused'));

      // A throw here would abort Nest bootstrap and crash-loop the API.
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('still propagates the error to direct reconcile() callers', async () => {
      prisma.permission.findMany.mockRejectedValue(new Error('connection refused'));

      await expect(service.reconcile()).rejects.toThrow('connection refused');
    });

    it('skips a role that does not exist instead of failing', async () => {
      const { permissions } = fullyInSyncState();
      prisma.permission.findMany.mockResolvedValue(permissions);
      prisma.rolePermission.findMany.mockResolvedValue([]);
      // Only the admin role exists.
      prisma.role.findMany.mockResolvedValue([{ id: ROLE_IDS.admin, name: 'admin' }]);

      const result = await service.reconcile();

      const grants = prisma.rolePermission.createMany.mock.calls[0][0].data;
      expect(grants.every((g: { roleId: string }) => g.roleId === ROLE_IDS.admin)).toBe(true);
      expect(result.grantsCreated).toBe(ROLE_PERMISSION_MATRIX.admin.length);
    });
  });
});
