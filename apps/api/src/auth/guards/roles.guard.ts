import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { toRequestUser, AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new ForbiddenException('No user in request');
    }

    // Attach the simplified user to the request unconditionally, regardless of
    // whether this route requires any specific role. Downstream code (e.g.
    // @CurrentUser()) falls back to request.requestUser, and a bare @Auth()
    // route (no roles/permissions) must still get the derived RequestUser
    // shape — including its `permissions`/`roles` arrays — not the raw
    // AuthenticatedUser, which has neither.
    const requestUser = toRequestUser(user);
    request.requestUser = requestUser;

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No roles required - allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // Check if user has at least one required role
    const hasRole = requiredRoles.some((role) =>
      requestUser.roles.includes(role),
    );

    if (!hasRole) {
      throw new ForbiddenException(
        `Required roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
