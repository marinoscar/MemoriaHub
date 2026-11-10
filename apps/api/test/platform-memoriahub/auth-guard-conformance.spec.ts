import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describeMemoriahubAuthGuardConformance } from '@marinoscar/memoriahub-api/testing';

import { PlatformMemoriahubIdentityAdapter } from '../../src/platform-memoriahub/identity/platform-memoriahub-identity.adapter';

// =============================================================================
// `@MemoriahubAuth()` decides like the platform `@Auth()` (RETRO-J5, #613)
// =============================================================================
//
// The guard conformance suite of the package, run over the real identity adapter. The platform
// `JwtAuthGuard` is a stand-in that attaches what the real one attaches (`user` with its role graph and
// `authCredential`); the adapter's normalisation and the package guard's decisions are the real code.

function userRow(roles: string[], permissions: string[]) {
  return {
    id: 'user-1',
    email: 'person.a@example.test',
    isActive: true,
    userRoles: roles.map((name, index) => ({
      role: {
        id: `role-${index}`,
        name,
        description: null,
        // The permissions ride on the first role (or on a synthetic one when the caller holds none).
        rolePermissions: index === 0 ? permissions.map((p, i) => ({ permission: { id: `perm-${i}`, name: p, description: null } })) : [],
      },
    })),
  };
}

describeMemoriahubAuthGuardConformance({ describe, it, expect }, () => ({
  caller: (caller) => {
    const request: Record<string, unknown> = caller ? { standIn: caller } : {};
    const jwt = {
      canActivate: async (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<Record<string, unknown>>();
        const standIn = req['standIn'] as { roles: string[]; permissions: string[]; credential?: 'jwt' | 'pat' | 'node' } | undefined;
        if (!standIn) throw new UnauthorizedException('Unauthorized');
        // A caller that holds permissions but no role still needs a role to carry them in the graph.
        const roles = standIn.roles.length > 0 ? standIn.roles : standIn.permissions.length > 0 ? ['carrier'] : [];
        req['user'] = userRow(roles, standIn.permissions);
        req['authCredential'] = { kind: standIn.credential ?? 'jwt' };
        return true;
      },
    };
    return { port: new PlatformMemoriahubIdentityAdapter(jwt as never, {} as never), request };
  },
}));
