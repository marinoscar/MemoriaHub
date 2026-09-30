/**
 * PushConfigController (epic #481, issue #483) — permission gates (real
 * guards over the real @Auth() metadata) plus request-body validation for the
 * typed confirmations and the VAPID subject rule.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import {
  generatePushConfigSchema,
  removePushConfigSchema,
  rotatePushConfigSchema,
  updatePushConfigSchema,
} from './dto/push-config.dto';
import { PushConfigController } from './push-config.controller';

type Handler = 'getConfig' | 'update' | 'generate' | 'rotate' | 'remove' | 'test';
const READ: Handler[] = ['getConfig'];
const WRITE: Handler[] = ['update', 'generate', 'rotate', 'remove', 'test'];

function ctx(handler: Handler, permissions: string[], roles: string[]) {
  const request: any = {
    user: {
      id: 'u',
      email: 'a@example.com',
      isActive: true,
      userRoles: roles.map((name) => ({
        role: { name, rolePermissions: permissions.map((p) => ({ permission: { name: p } })) },
      })),
    },
  };
  return {
    getHandler: () => PushConfigController.prototype[handler],
    getClass: () => PushConfigController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PushConfigController', () => {
  const reflector = new Reflector();
  const permissionsGuard = new PermissionsGuard(reflector);
  const rolesGuard = new RolesGuard(reflector);

  it('declares the Admin role on every route', () => {
    for (const h of [...READ, ...WRITE]) {
      expect(Reflect.getMetadata(ROLES_KEY, PushConfigController.prototype[h])).toEqual([
        ROLES.ADMIN,
      ]);
    }
  });

  it('gates GET on push:read and every mutation (incl. test) on push:write', () => {
    for (const h of READ) {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, PushConfigController.prototype[h])).toEqual([
        PERMISSIONS.PUSH_READ,
      ]);
    }
    for (const h of WRITE) {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, PushConfigController.prototype[h])).toEqual([
        PERMISSIONS.PUSH_WRITE,
      ]);
    }
  });

  it.each(WRITE)('rejects a push:read-only admin on %s', (h) => {
    expect(() => permissionsGuard.canActivate(ctx(h, [PERMISSIONS.PUSH_READ], [ROLES.ADMIN]))).toThrow(
      ForbiddenException,
    );
  });

  it.each(WRITE)('allows a push:write admin on %s', (h) => {
    const c = ctx(h, [PERMISSIONS.PUSH_WRITE], [ROLES.ADMIN]);
    expect(rolesGuard.canActivate(c)).toBe(true);
    expect(permissionsGuard.canActivate(c)).toBe(true);
  });

  it('rejects a non-admin even with the permission', () => {
    expect(() =>
      rolesGuard.canActivate(ctx('getConfig', [PERMISSIONS.PUSH_READ], [ROLES.CONTRIBUTOR])),
    ).toThrow(ForbiddenException);
  });

  describe('body schemas', () => {
    it('rotate/remove require their own exact confirmation words', () => {
      expect(rotatePushConfigSchema.safeParse({ confirmation: 'ROTATE' }).success).toBe(true);
      expect(rotatePushConfigSchema.safeParse({ confirmation: 'rotate' }).success).toBe(false);
      expect(rotatePushConfigSchema.safeParse({ confirmation: 'REMOVE' }).success).toBe(false);
      expect(rotatePushConfigSchema.safeParse({}).success).toBe(false);
      expect(removePushConfigSchema.safeParse({ confirmation: 'REMOVE' }).success).toBe(true);
      expect(removePushConfigSchema.safeParse({ confirmation: 'ROTATE' }).success).toBe(false);
    });

    it('subject must be mailto: or https:', () => {
      for (const ok of ['mailto:ops@example.com', 'https://example.com']) {
        expect(updatePushConfigSchema.safeParse({ subject: ok }).success).toBe(true);
        expect(generatePushConfigSchema.safeParse({ subject: ok }).success).toBe(true);
      }
      for (const bad of ['http://example.com', 'ops@example.com', 'mailto:', 'ftp://x']) {
        expect(updatePushConfigSchema.safeParse({ subject: bad }).success).toBe(false);
      }
      expect(updatePushConfigSchema.safeParse({ subject: null }).success).toBe(true);
    });

    it('PUT cannot set key material', () => {
      expect(updatePushConfigSchema.safeParse({ publicKey: 'x' }).success).toBe(false);
      expect(updatePushConfigSchema.safeParse({ privateKey: 'x' }).success).toBe(false);
    });
  });
});
