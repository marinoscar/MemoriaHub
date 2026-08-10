import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  DatabaseRestoreAlreadyRunningError,
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreNotFoundError,
} from './database-restore.service';

import { DatabaseBackupController } from './db-backup.controller';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

/**
 * Controller specs for `/api/admin/db-backup/*` (issue #343, epic #339).
 *
 * The permission tests run the REAL `PermissionsGuard`/`RolesGuard` against the
 * REAL decorator metadata, rather than asserting the metadata array's contents.
 * A metadata equality check would pass just as happily if the guard were never
 * wired up; running the guard is what actually proves a `db_backup:read` token
 * is turned away from a write route.
 */

type Handler = keyof DatabaseBackupController;

const READ_ROUTES: Handler[] = ['getConfig', 'listRuns', 'getRun', 'download'];
const WRITE_ROUTES: Handler[] = [
  'updateConfig',
  'startRun',
  'deleteRun',
  'cancelRun',
];
/** #344's two routes sit behind their OWN permission, not `db_backup:write`. */
const RESTORE_ROUTES: Handler[] = ['restore', 'rollback'];

function contextFor(handler: Handler, permissions: string[], roles: string[]) {
  const request: any = {
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      isActive: true,
      userRoles: roles.map((name) => ({
        role: {
          name,
          rolePermissions: permissions.map((p) => ({ permission: { name: p } })),
        },
      })),
    },
  };

  return {
    getHandler: () => DatabaseBackupController.prototype[handler],
    getClass: () => DatabaseBackupController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('DatabaseBackupController (permission gates)', () => {
  let permissionsGuard: PermissionsGuard;
  let rolesGuard: RolesGuard;

  beforeEach(() => {
    const reflector = new Reflector();
    permissionsGuard = new PermissionsGuard(reflector);
    rolesGuard = new RolesGuard(reflector);
  });

  it('declares Admin role on every route', () => {
    for (const handler of [...READ_ROUTES, ...WRITE_ROUTES, ...RESTORE_ROUTES]) {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        DatabaseBackupController.prototype[handler],
      );
      expect(roles).toEqual([ROLES.ADMIN]);
    }
  });

  it.each(READ_ROUTES)('allows a db_backup:read admin on %s', (handler) => {
    const ctx = contextFor(handler, [PERMISSIONS.DB_BACKUP_READ], [ROLES.ADMIN]);
    expect(rolesGuard.canActivate(ctx)).toBe(true);
    expect(permissionsGuard.canActivate(ctx)).toBe(true);
  });

  it.each(WRITE_ROUTES)(
    'rejects a db_backup:read-only admin on %s',
    (handler) => {
      const ctx = contextFor(
        handler,
        [PERMISSIONS.DB_BACKUP_READ],
        [ROLES.ADMIN],
      );
      expect(() => permissionsGuard.canActivate(ctx)).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(WRITE_ROUTES)('allows a db_backup:write admin on %s', (handler) => {
    const ctx = contextFor(
      handler,
      [PERMISSIONS.DB_BACKUP_WRITE],
      [ROLES.ADMIN],
    );
    expect(permissionsGuard.canActivate(ctx)).toBe(true);
  });

  it('rejects a non-admin holding the permission', () => {
    const ctx = contextFor(
      'getConfig',
      [PERMISSIONS.DB_BACKUP_READ],
      ['contributor'],
    );
    expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it.each(RESTORE_ROUTES)(
    'requires db_backup:restore on %s — write is not enough',
    (handler) => {
      const writeOnly = contextFor(
        handler,
        [PERMISSIONS.DB_BACKUP_READ, PERMISSIONS.DB_BACKUP_WRITE],
        [ROLES.ADMIN],
      );
      expect(() => permissionsGuard.canActivate(writeOnly)).toThrow(
        ForbiddenException,
      );

      const allowed = contextFor(
        handler,
        [PERMISSIONS.DB_BACKUP_RESTORE],
        [ROLES.ADMIN],
      );
      expect(rolesGuard.canActivate(allowed)).toBe(true);
      expect(permissionsGuard.canActivate(allowed)).toBe(true);
    },
  );

  it.each(RESTORE_ROUTES)(
    'rejects a non-admin holding db_backup:restore on %s',
    (handler) => {
      const ctx = contextFor(
        handler,
        [PERMISSIONS.DB_BACKUP_RESTORE],
        ['contributor'],
      );
      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
    },
  );

  it('declares db_backup:read on the download route, not a write permission', () => {
    const perms = Reflect.getMetadata(
      PERMISSIONS_KEY,
      DatabaseBackupController.prototype.download,
    );
    expect(perms).toEqual([PERMISSIONS.DB_BACKUP_READ]);
  });
});

describe('DatabaseBackupController (delegation)', () => {
  const service = {
    getConfig: jest.fn(),
    updateConfig: jest.fn(),
    startRun: jest.fn(),
    listRuns: jest.fn(),
    getRun: jest.fn(),
    getDownloadUrl: jest.fn(),
    deleteRun: jest.fn(),
    cancelRun: jest.fn(),
  };
  const restoreService = {
    startRestore: jest.fn(),
    rollback: jest.fn(),
  };
  const controller = new DatabaseBackupController(
    service as any,
    restoreService as any,
  );
  const user = { id: 'user-1' } as any;

  beforeEach(() => jest.clearAllMocks());

  it('passes the caller id through on config update', async () => {
    await controller.updateConfig({ enabled: true } as any, user);
    expect(service.updateConfig).toHaveBeenCalledWith({ enabled: true }, 'user-1');
  });

  it('passes the caller id through on manual trigger', async () => {
    await controller.startRun(user);
    expect(service.startRun).toHaveBeenCalledWith('user-1');
  });

  it('forwards the download query', async () => {
    await controller.download('run-1', { expiresIn: 900 } as any);
    expect(service.getDownloadUrl).toHaveBeenCalledWith('run-1', {
      expiresIn: 900,
    });
  });

  it('passes the caller id and schema override through on restore', async () => {
    restoreService.startRestore.mockResolvedValue({ mode: 'running' });
    await controller.restore(
      'run-1',
      { confirmation: 'RESTORE', overrideSchemaCheck: true } as any,
      user,
    );
    expect(restoreService.startRestore).toHaveBeenCalledWith('run-1', {
      userId: 'user-1',
      overrideSchemaCheck: true,
    });
  });

  it('defaults overrideSchemaCheck to false rather than undefined', async () => {
    restoreService.startRestore.mockResolvedValue({ mode: 'running' });
    await controller.restore('run-1', { confirmation: 'RESTORE' } as any, user);
    expect(restoreService.startRestore).toHaveBeenCalledWith('run-1', {
      userId: 'user-1',
      overrideSchemaCheck: false,
    });
  });

  it('maps a concurrent restore onto 409 carrying the active run id', async () => {
    restoreService.startRestore.mockRejectedValue(
      new DatabaseRestoreAlreadyRunningError('run-other'),
    );
    await expect(
      controller.restore('run-1', { confirmation: 'RESTORE' } as any, user),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps an unknown run onto 404 and a disallowed run onto 400', async () => {
    restoreService.rollback.mockRejectedValue(
      new DatabaseRestoreNotFoundError('run-1'),
    );
    await expect(
      controller.rollback('run-1', { confirmation: 'ROLLBACK' } as any, user),
    ).rejects.toBeInstanceOf(NotFoundException);

    restoreService.rollback.mockRejectedValue(
      new DatabaseRestoreNotAllowedError('nope'),
    );
    await expect(
      controller.rollback('run-1', { confirmation: 'ROLLBACK' } as any, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
