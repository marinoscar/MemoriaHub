import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MemoriahubAuth,
  MemoriahubAuthGuard,
  MemoriahubPublic,
  memoriahubCredentialOf,
  memoriahubUserOf,
} from '../core/index.js';
import type { MemoriahubCredentialKind, MemoriahubIdentityPort } from '../ports/index.js';
import type { MemoriahubConformanceHarness } from './conformance.js';

// =============================================================================
// describeMemoriahubAuthGuardConformance (RETRO-J5, #613)
// =============================================================================
//
// The executable proof that `@MemoriahubAuth()` decides a request the way the web edition's `@Auth()`
// does, for a given binding of the identity port: the fake of this package passes it, and the web
// edition's adapter over the platform guard passes it. The refusals' messages are part of the proof,
// since they reach the client.
// =============================================================================

/**
 * A caller to build.
 *
 * @stability experimental
 */
export interface MemoriahubAuthGuardCaller {
  /** The role names the caller holds. */
  roles: string[];
  /** The permissions the caller holds. */
  permissions: string[];
  /** The credential kind the caller authenticates with. */
  credential?: MemoriahubCredentialKind;
}

/**
 * What the kit needs to test the guard.
 *
 * @stability experimental
 */
export interface MemoriahubAuthGuardUnderTest {
  /**
   * Builds the identity port and the request for a caller (`null` for an anonymous request).
   *
   * @param caller - the caller to build.
   */
  caller(caller: MemoriahubAuthGuardCaller | null): { port: MemoriahubIdentityPort; request: Record<string, unknown> };
}

class ConformanceRoutes {
  @MemoriahubPublic()
  open(): void {}

  @MemoriahubAuth()
  signedIn(): void {}

  @MemoriahubAuth({ permissions: ['media:read'] })
  reads(): void {}

  @MemoriahubAuth({ permissions: ['media:read', 'media:write'] })
  readsAndWrites(): void {}

  @MemoriahubAuth({ anyPermissions: ['media:write', 'media:delete'] })
  writesOrDeletes(): void {}

  @MemoriahubAuth({ roles: ['admin'], permissions: ['media:delete'] })
  adminDeletes(): void {}

  @MemoriahubAuth({ credentials: ['pat'] })
  patOnly(): void {}
}

function contextFor(handler: () => void, request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ConformanceRoutes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Registers the guard rules in the caller's test runner.
 *
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @param make - builds a fresh {@link MemoriahubAuthGuardUnderTest}.
 * @stability experimental
 */
export function describeMemoriahubAuthGuardConformance(
  harness: MemoriahubConformanceHarness,
  make: () => MemoriahubAuthGuardUnderTest,
): void {
  const h = harness;
  const routes = new ConformanceRoutes();

  async function run(
    handler: () => void,
    caller: MemoriahubAuthGuardCaller | null,
  ): Promise<{ error: unknown; request: Record<string, unknown> }> {
    const { port, request } = make().caller(caller);
    const guard = new MemoriahubAuthGuard(new Reflector(), port);
    const error = await refusal(guard.canActivate(contextFor(handler, request)));
    return { error, request };
  }

  h.describe('MemoriahubAuthGuard', () => {
    h.it('lets a public route through with no credentials and attaches no user', async () => {
      const { error, request } = await run(routes.open, null);
      h.expect(error).toBeUndefined();
      h.expect(memoriahubUserOf(request)).toBeUndefined();
    });

    h.it('answers 401 to an anonymous request on a protected route', async () => {
      const { error } = await run(routes.signedIn, null);
      h.expect(error).toBeInstanceOf(UnauthorizedException);
    });

    h.it('admits any signed-in caller where no requirement is declared and attaches the user and credential', async () => {
      const { error, request } = await run(routes.signedIn, { roles: [], permissions: [], credential: 'jwt' });
      h.expect(error).toBeUndefined();
      const user = memoriahubUserOf(request);
      h.expect(typeof user?.id).toBe('string');
      h.expect(Array.isArray(user?.permissions)).toBe(true);
      h.expect(memoriahubCredentialOf(request)?.kind).toBe('jwt');
    });

    h.it('admits a caller that holds the permission and refuses one that lacks it with the missing names', async () => {
      h.expect((await run(routes.reads, { roles: ['viewer'], permissions: ['media:read'] })).error).toBeUndefined();
      const { error } = await run(routes.reads, { roles: ['viewer'], permissions: ['media:write'] });
      h.expect(error).toBeInstanceOf(ForbiddenException);
      h.expect((error as ForbiddenException).message).toBe('Missing permissions: media:read');
    });

    h.it('requires every listed permission and names only those missing', async () => {
      h.expect((await run(routes.readsAndWrites, { roles: [], permissions: ['media:read', 'media:write'] })).error).toBeUndefined();
      const { error } = await run(routes.readsAndWrites, { roles: [], permissions: ['media:read'] });
      h.expect(error).toBeInstanceOf(ForbiddenException);
      h.expect((error as ForbiddenException).message).toBe('Missing permissions: media:write');
    });

    h.it('requires one of the alternative permissions', async () => {
      h.expect((await run(routes.writesOrDeletes, { roles: [], permissions: ['media:delete'] })).error).toBeUndefined();
      const { error } = await run(routes.writesOrDeletes, { roles: [], permissions: ['media:read'] });
      h.expect(error).toBeInstanceOf(ForbiddenException);
      h.expect((error as ForbiddenException).message).toBe('Missing permissions: one of media:write, media:delete');
    });

    h.it('checks the role before the permission', async () => {
      const lacksBoth = await run(routes.adminDeletes, { roles: ['viewer'], permissions: [] });
      h.expect((lacksBoth.error as ForbiddenException).message).toBe('Required roles: admin');
      const lacksPermission = await run(routes.adminDeletes, { roles: ['admin'], permissions: [] });
      h.expect((lacksPermission.error as ForbiddenException).message).toBe('Missing permissions: media:delete');
      h.expect((await run(routes.adminDeletes, { roles: ['admin'], permissions: ['media:delete'] })).error).toBeUndefined();
    });

    h.it('restricts a route to the credential kinds it names', async () => {
      h.expect((await run(routes.patOnly, { roles: [], permissions: [], credential: 'pat' })).error).toBeUndefined();
      const { error } = await run(routes.patOnly, { roles: [], permissions: [], credential: 'jwt' });
      h.expect(error).toBeInstanceOf(ForbiddenException);
    });
  });
}
