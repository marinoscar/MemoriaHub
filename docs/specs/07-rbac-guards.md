# Spec 07: RBAC Guards and Decorators

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 05-auth-google-oauth, 03-database-seeds
**Estimated Complexity:** Medium

---

## Objective

Implement role-based and permission-based access control guards with declarative decorators for protecting API endpoints.

---

## Deliverables

### 1. File Structure

```
apps/api/src/auth/
├── guards/
│   ├── jwt-auth.guard.ts      # (existing)
│   ├── roles.guard.ts         # NEW
│   └── permissions.guard.ts   # NEW
├── decorators/
│   ├── current-user.decorator.ts  # (existing)
│   ├── public.decorator.ts        # (existing)
│   ├── roles.decorator.ts         # NEW
│   └── permissions.decorator.ts   # NEW
└── interfaces/
    └── authenticated-user.interface.ts  # NEW
```

### 2. Authenticated User Interface

Create `apps/api/src/auth/interfaces/authenticated-user.interface.ts`:

```typescript
import { User, Role, Permission } from '@prisma/client';

/**
 * User object attached to request after JWT validation
 */
export interface AuthenticatedUser extends User {
  userRoles: Array<{
    role: Role & {
      rolePermissions: Array<{
        permission: Permission;
      }>;
    };
  }>;
}

/**
 * Simplified user info for request context
 */
export interface RequestUser {
  id: string;
  email: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
}

/**
 * Extract RequestUser from AuthenticatedUser
 */
export function toRequestUser(user: AuthenticatedUser): RequestUser {
  const roles = user.userRoles.map((ur) => ur.role.name);
  const permissions = [
    ...new Set(
      user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      ),
    ),
  ];

  return {
    id: user.id,
    email: user.email,
    roles,
    permissions,
    isActive: user.isActive,
  };
}
```

### 3. Roles Decorator

Create `apps/api/src/auth/decorators/roles.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';
import { RoleName } from '../../common/constants/roles.constants';

export const ROLES_KEY = 'roles';

/**
 * Decorator to specify required roles for an endpoint
 * User must have AT LEAST ONE of the specified roles
 *
 * @example
 * @Roles(ROLES.ADMIN)
 * @Roles(ROLES.ADMIN, ROLES.CONTRIBUTOR)
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
```

### 4. Permissions Decorator

Create `apps/api/src/auth/decorators/permissions.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';
import { PermissionName } from '../../common/constants/roles.constants';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator to specify required permissions for an endpoint
 * User must have ALL of the specified permissions
 *
 * @example
 * @Permissions(PERMISSIONS.USERS_READ)
 * @Permissions(PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE)
 */
export const Permissions = (...permissions: PermissionName[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
```

### 5. Roles Guard

Create `apps/api/src/auth/guards/roles.guard.ts`:

```typescript
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
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No roles required - allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new ForbiddenException('No user in request');
    }

    const requestUser = toRequestUser(user);

    // Check if user has at least one required role
    const hasRole = requiredRoles.some((role) =>
      requestUser.roles.includes(role),
    );

    if (!hasRole) {
      throw new ForbiddenException(
        `Required roles: ${requiredRoles.join(', ')}`,
      );
    }

    // Attach simplified user to request for convenience
    request.requestUser = requestUser;

    return true;
  }
}
```

### 6. Permissions Guard

Create `apps/api/src/auth/guards/permissions.guard.ts`:

```typescript
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { toRequestUser, AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No permissions required - allow access
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new ForbiddenException('No user in request');
    }

    const requestUser = toRequestUser(user);

    // Check if user has ALL required permissions
    const hasAllPermissions = requiredPermissions.every((permission) =>
      requestUser.permissions.includes(permission),
    );

    if (!hasAllPermissions) {
      const missing = requiredPermissions.filter(
        (p) => !requestUser.permissions.includes(p),
      );
      throw new ForbiddenException(
        `Missing permissions: ${missing.join(', ')}`,
      );
    }

    // Attach simplified user to request for convenience
    request.requestUser = requestUser;

    return true;
  }
}
```

### 7. Combined Auth Decorator

Create `apps/api/src/auth/decorators/auth.decorator.ts`:

```typescript
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
```

### 8. Export Decorators Index

Create `apps/api/src/auth/decorators/index.ts`:

```typescript
export * from './auth.decorator';
export * from './current-user.decorator';
export * from './permissions.decorator';
export * from './public.decorator';
export * from './roles.decorator';
```

### 9. Export Guards Index

Create `apps/api/src/auth/guards/index.ts`:

```typescript
export * from './google-oauth.guard';
export * from './jwt-auth.guard';
export * from './permissions.guard';
export * from './roles.guard';
```

---

## Usage Examples

### Basic Authentication

```typescript
import { Controller, Get } from '@nestjs/common';
import { Auth, CurrentUser } from '../auth/decorators';

@Controller('profile')
export class ProfileController {
  @Get()
  @Auth() // Just requires valid JWT
  getProfile(@CurrentUser('id') userId: string) {
    return { userId };
  }
}
```

### Role-Based Access

```typescript
import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ROLES } from '../common/constants/roles.constants';

@Controller('admin')
export class AdminController {
  @Get('dashboard')
  @Auth({ roles: [ROLES.ADMIN] })
  getDashboard() {
    return { message: 'Admin dashboard' };
  }

  @Get('reports')
  @Auth({ roles: [ROLES.ADMIN, ROLES.CONTRIBUTOR] })
  getReports() {
    return { message: 'Reports (admin or contributor)' };
  }
}
```

### Permission-Based Access

```typescript
import { Controller, Get, Patch, Body, Param } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { PERMISSIONS } from '../common/constants/roles.constants';

@Controller('users')
export class UsersController {
  @Get()
  @Auth({ permissions: [PERMISSIONS.USERS_READ] })
  listUsers() {
    return [];
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE] })
  updateUser(@Param('id') id: string, @Body() data: any) {
    return { id, ...data };
  }
}
```

### Combined Roles and Permissions

```typescript
import { Controller, Put, Body } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ROLES, PERMISSIONS } from '../common/constants/roles.constants';

@Controller('system-settings')
export class SystemSettingsController {
  @Put()
  @Auth({
    roles: [ROLES.ADMIN],
    permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE],
  })
  updateSettings(@Body() data: any) {
    return data;
  }
}
```

---

## Request User Access

After guards run, the simplified user is available:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

@Controller('example')
export class ExampleController {
  @Get()
  @Auth()
  getExample(@Req() req: FastifyRequest & { requestUser: RequestUser }) {
    const { roles, permissions } = req.requestUser;
    return { roles, permissions };
  }
}
```

---

## Guard Execution Order

1. **JwtAuthGuard** - Validates JWT, attaches full user to request
2. **RolesGuard** - Checks if user has required roles
3. **PermissionsGuard** - Checks if user has required permissions

If any guard fails, a 401 (Unauthorized) or 403 (Forbidden) response is returned.

---

## Acceptance Criteria

- [ ] `@Auth()` decorator requires valid JWT token
- [ ] `@Roles()` decorator checks user has at least one required role
- [ ] `@Permissions()` decorator checks user has all required permissions
- [ ] `@Auth({ roles, permissions })` combines all checks
- [ ] Missing token returns 401 Unauthorized
- [ ] Invalid/expired token returns 401 Unauthorized
- [ ] Missing role returns 403 Forbidden with role list
- [ ] Missing permission returns 403 Forbidden with permission list
- [ ] `@CurrentUser()` extracts user data from request
- [ ] Swagger docs show auth requirements

---

## Notes

- Roles use OR logic (user needs ANY of the roles)
- Permissions use AND logic (user needs ALL permissions)
- Guards run in order: JWT → Roles → Permissions
- Full user attached to `request.user`
- Simplified user attached to `request.requestUser`
- Public endpoints use `@Public()` decorator to skip JWT guard
