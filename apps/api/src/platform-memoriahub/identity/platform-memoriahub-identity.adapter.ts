import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  JwtAuthGuard,
  PRINCIPAL_USER_INCLUDE,
  activeOrgIdOf,
  principalFactory,
  principalOf,
  toRequestUser,
  type AuthenticatedUser,
  type RequestWithPrincipal,
} from '@marinoscar/platform-api/identity';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { MEMORIAHUB_AUTH_FAILURE_PROPERTY } from '@marinoscar/memoriahub-api/core';
import type { MemoriahubIdentityPort, MemoriahubPrincipal } from '@marinoscar/memoriahub-api/ports';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// PlatformMemoriahubIdentityAdapter: the `MEMORIAHUB_IDENTITY` port over the platform identity slice
// (RETRO-J4, #610)
// =============================================================================
//
// `authenticate` runs the platform `JwtAuthGuard` (JWT, PAT or node credential, whichever the request
// carries) and normalises the result, reading the host's own request shape so a slice never does: on a
// route that declares no permission the platform guards attach no normalised user, and a slice that read
// one would silently see none (the permissionless-route trap). An inactive user is not authenticated.
// =============================================================================

@Injectable()
export class PlatformMemoriahubIdentityAdapter implements MemoriahubIdentityPort {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly prisma: PrismaService,
  ) {}

  @Trace()
  async authenticate(context: ExecutionContext): Promise<MemoriahubPrincipal | null> {
    try {
      await this.jwt.canActivate(context);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        // The guard of the package answers with the platform's own message (an expired personal access
        // token reads differently from a missing header), so a slice's route refuses exactly as `@Auth()` did.
        context.switchToHttp().getRequest<Record<string, unknown>>()[MEMORIAHUB_AUTH_FAILURE_PROPERTY] = error.message;
        return null;
      }
      throw error;
    }

    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal & { user?: AuthenticatedUser; authCredential?: { kind: 'jwt' | 'pat' | 'node'; tokenId?: string } }>();
    const user = request.user;
    if (!user) return null;

    const requestUser = toRequestUser(user);
    if (!requestUser.isActive) return null;

    const principal = principalOf(request);

    return {
      userId: user.id,
      orgId: activeOrgIdOf(request) ?? null,
      roles: principal?.roles ?? requestUser.roles,
      permissions: new Set(principal?.permissions ?? requestUser.permissions),
      ...(request.authCredential ? { credential: { ...request.authCredential } } : {}),
    };
  }

  @Trace()
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    return (await this.permissionsOf(userId)).includes(permission);
  }

  @Trace()
  async permissionsOf(userId: string): Promise<readonly string[]> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      include: PRINCIPAL_USER_INCLUDE,
    })) as unknown as AuthenticatedUser | null;
    if (!user || !user.isActive) return [];

    return principalFactory.access(user).permissions;
  }
}
