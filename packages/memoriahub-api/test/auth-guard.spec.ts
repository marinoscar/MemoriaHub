import { describe, expect, it } from '@jest/globals';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MEMORIAHUB_AUTH_FAILURE_PROPERTY,
  MemoriahubAuth,
  MemoriahubAuthGuard,
  MEMORIAHUB_PERMISSIONS_KEY,
  MEMORIAHUB_ROLES_KEY,
} from '../src/core/index.js';
import { FAKE_PRINCIPAL_KEY, FakeMemoriahubIdentity, describeMemoriahubAuthGuardConformance } from '../src/testing/index.js';

describeMemoriahubAuthGuardConformance({ describe, it, expect }, () => {
  const identity = new FakeMemoriahubIdentity();
  return {
    caller: (caller) => {
      if (!caller) return { port: identity, request: {} };
      identity.addUser({
        userId: 'user-1',
        orgId: null,
        roles: caller.roles,
        permissions: new Set(caller.permissions),
        ...(caller.credential ? { credential: { kind: caller.credential } } : {}),
      });
      return { port: identity, request: { [FAKE_PRINCIPAL_KEY]: 'user-1' } };
    },
  };
});

describe('MemoriahubAuth metadata', () => {
  class Routes {
    @MemoriahubAuth({ roles: ['admin'], permissions: ['media:read'] })
    handler(): void {}
  }

  it('writes the metadata keys the web edition reads', () => {
    const reflector = new Reflector();
    expect(reflector.get(MEMORIAHUB_ROLES_KEY, Routes.prototype.handler)).toEqual(['admin']);
    expect(reflector.get(MEMORIAHUB_PERMISSIONS_KEY, Routes.prototype.handler)).toEqual(['media:read']);
    expect(MEMORIAHUB_ROLES_KEY).toBe('roles');
    expect(MEMORIAHUB_PERMISSIONS_KEY).toBe('permissions');
  });

  it('answers with the message the binding stored when it rejects a request', async () => {
    const request: Record<string, unknown> = { [MEMORIAHUB_AUTH_FAILURE_PROPERTY]: 'Invalid or expired personal access token' };
    const port = { authenticate: async () => null, hasPermission: async () => false, permissionsOf: async () => [] };
    const guard = new MemoriahubAuthGuard(new Reflector(), port);
    const context = { getHandler: () => Routes.prototype.handler, getClass: () => Routes, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toThrow(new UnauthorizedException('Invalid or expired personal access token'));
  });
});
