import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { Roles } from './roles.decorator';
import { Permissions } from './permissions.decorator';
import { RoleName, PermissionName } from '../../common/constants/roles.constants';

interface AuthOptions {
  roles?: RoleName[];
  permissions?: PermissionName[];
}

/**
 * Combined auth decorator that applies JWT, roles, and permissions guards
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
 * // Combined
 * @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
 */
export function Auth(options: AuthOptions = {}) {
  const decorators = [
    UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard),
    ApiBearerAuth('JWT-auth'),
    ApiUnauthorizedResponse({ description: 'Unauthorized - Invalid or missing token' }),
    ApiForbiddenResponse({ description: 'Forbidden - Insufficient permissions' }),
  ];

  if (options.roles && options.roles.length > 0) {
    decorators.push(Roles(...options.roles));
  }

  if (options.permissions && options.permissions.length > 0) {
    decorators.push(Permissions(...options.permissions));
  }

  return applyDecorators(...decorators);
}
