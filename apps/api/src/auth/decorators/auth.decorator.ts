import { applyDecorators, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { Roles } from './roles.decorator';
import { Permissions } from './permissions.decorator';
import { RoleName, PermissionName } from '../../common/constants/roles.constants';
import { ErrorDto } from '../../common/dto/error.dto';

/**
 * Per-circle role ranks, lowest first. Independent of the system role: an
 * authenticated call must satisfy the system permission AND the circle role.
 */
export type CircleRoleName = 'viewer' | 'collaborator' | 'circle_admin';

interface AuthOptions {
  roles?: RoleName[];
  permissions?: PermissionName[];
  /**
   * Minimum per-circle role the route enforces, for documentation only.
   *
   * There is no per-circle guard to derive this from — circle membership is
   * checked inside the services, which the decorator cannot see — so it is
   * declared here when a route has one. Omitting it means "this route is not
   * circle-scoped", not "any member may call it".
   */
  circleRole?: CircleRoleName;
}

/**
 * The vendor extension `@Auth()` stamps onto each operation.
 *
 * Read back out of the OpenAPI document by `applyRbacDocs()` (see
 * `src/openapi/rbac-docs.ts`), which renders it into the operation description.
 * Going through the document rather than the Nest container is what keeps the
 * generated line honest: it is derived from the same decorator call the guards
 * are configured by, so a permission change edits the docs by construction.
 */
export const RBAC_EXTENSION_KEY = 'x-rbac';

export interface RbacExtension {
  authenticated: true;
  /** Caller needs ANY of these system roles. Empty means no role requirement. */
  roles: RoleName[];
  /** Caller needs ALL of these permissions. Empty means no permission requirement. */
  permissions: PermissionName[];
  /** Minimum per-circle role, when the route is circle-scoped. */
  circleRole?: CircleRoleName;
}

/**
 * Combined auth decorator that applies JWT, roles, and permissions guards, and
 * documents what it just enforced.
 *
 * @example
 * // Just authentication
 * @Auth()
 *
 * // With roles (user needs ANY of the roles)
 * @Auth({ roles: [ROLES.ADMIN] })
 *
 * // With permissions (user needs ALL permissions)
 * @Auth({ permissions: [PERMISSIONS.USERS_READ] })
 *
 * // Combined, and circle-scoped
 * @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE], circleRole: 'collaborator' })
 */
export function Auth(options: AuthOptions = {}) {
  const rbac: RbacExtension = {
    authenticated: true,
    roles: options.roles ?? [],
    permissions: options.permissions ?? [],
    ...(options.circleRole ? { circleRole: options.circleRole } : {}),
  };

  const decorators = [
    UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard),
    ApiBearerAuth('JWT-auth'),
    ApiExtension(RBAC_EXTENSION_KEY, rbac),
    ApiUnauthorizedResponse({
      description: 'Missing, malformed, or expired bearer token.',
      type: ErrorDto,
    }),
    ApiForbiddenResponse({
      description: 'Authenticated, but the caller lacks a required role, permission, or circle role.',
      type: ErrorDto,
    }),
  ];

  if (options.roles && options.roles.length > 0) {
    decorators.push(Roles(...options.roles));
  }

  if (options.permissions && options.permissions.length > 0) {
    decorators.push(Permissions(...options.permissions));
  }

  return applyDecorators(...decorators);
}
