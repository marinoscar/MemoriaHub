# Spec 08: Users Management Endpoints

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 07-rbac-guards
**Estimated Complexity:** Medium

---

## Objective

Implement admin-only user management endpoints for listing, viewing, and updating users including role assignments and account activation.

---

## Deliverables

### 1. File Structure

```
apps/api/src/users/
├── users.module.ts
├── users.controller.ts
├── users.service.ts
└── dto/
    ├── user-response.dto.ts
    ├── user-list-query.dto.ts
    ├── update-user.dto.ts
    └── update-user-roles.dto.ts
```

### 2. DTOs

Create `apps/api/src/users/dto/user-response.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  providerDisplayName: z.string().nullable(),
  profileImageUrl: z.string().url().nullable(),
  providerProfileImageUrl: z.string().url().nullable(),
  isActive: z.boolean(),
  roles: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export class UserResponseDto extends createZodDto(userResponseSchema) {}

// List response with pagination
export const userListResponseSchema = z.object({
  items: z.array(userResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

export class UserListResponseDto extends createZodDto(userListResponseSchema) {}
```

Create `apps/api/src/users/dto/user-list-query.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  role: z.string().optional(),
  isActive: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  sortBy: z.enum(['email', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class UserListQueryDto extends createZodDto(userListQuerySchema) {}
```

Create `apps/api/src/users/dto/update-user.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
```

Create `apps/api/src/users/dto/update-user-roles.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserRolesSchema = z.object({
  roleNames: z.array(z.string()).min(1, 'At least one role is required'),
});

export class UpdateUserRolesDto extends createZodDto(updateUserRolesSchema) {}
```

### 3. Users Service

Create `apps/api/src/users/users.service.ts`:

```typescript
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';
import { ROLES } from '../common/constants/roles.constants';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List users with pagination and filtering
   */
  async listUsers(query: UserListQueryDto) {
    const { page, pageSize, search, role, isActive, sortBy, sortOrder } = query;
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { providerDisplayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.userRoles = {
        some: {
          role: { name: role },
        },
      };
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    // Execute query
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          userRoles: {
            include: { role: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // Transform to response format
    const transformedItems = items.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      providerDisplayName: user.providerDisplayName,
      profileImageUrl: user.profileImageUrl,
      providerProfileImageUrl: user.providerProfileImageUrl,
      isActive: user.isActive,
      roles: user.userRoles.map((ur) => ur.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));

    return {
      items: transformedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Get user by ID
   */
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: { role: true },
        },
        identities: {
          select: {
            provider: true,
            providerEmail: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      providerDisplayName: user.providerDisplayName,
      profileImageUrl: user.profileImageUrl,
      providerProfileImageUrl: user.providerProfileImageUrl,
      isActive: user.isActive,
      roles: user.userRoles.map((ur) => ur.role.name),
      identities: user.identities,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Update user (admin actions)
   */
  async updateUser(
    id: string,
    dto: UpdateUserDto,
    adminUserId: string,
  ) {
    // Prevent admin from deactivating themselves
    if (dto.isActive === false && id === adminUserId) {
      throw new ForbiddenException('Cannot deactivate your own account');
    }

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        isActive: dto.isActive,
      },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    // Log audit event
    await this.createAuditEvent(adminUserId, 'user:update', 'user', id, {
      changes: dto,
    });

    this.logger.log(`User ${id} updated by admin ${adminUserId}`);

    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      providerDisplayName: updated.providerDisplayName,
      profileImageUrl: updated.profileImageUrl,
      providerProfileImageUrl: updated.providerProfileImageUrl,
      isActive: updated.isActive,
      roles: updated.userRoles.map((ur) => ur.role.name),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Update user roles
   */
  async updateUserRoles(
    id: string,
    dto: UpdateUserRolesDto,
    adminUserId: string,
  ) {
    // Prevent admin from removing their own admin role
    if (id === adminUserId && !dto.roleNames.includes(ROLES.ADMIN)) {
      throw new ForbiddenException('Cannot remove admin role from yourself');
    }

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // Validate all roles exist
    const roles = await this.prisma.role.findMany({
      where: { name: { in: dto.roleNames } },
    });

    if (roles.length !== dto.roleNames.length) {
      const foundNames = roles.map((r) => r.name);
      const invalid = dto.roleNames.filter((n) => !foundNames.includes(n));
      throw new BadRequestException(`Invalid roles: ${invalid.join(', ')}`);
    }

    // Replace all roles in a transaction
    await this.prisma.$transaction(async (tx) => {
      // Remove existing roles
      await tx.userRole.deleteMany({ where: { userId: id } });

      // Add new roles
      await tx.userRole.createMany({
        data: roles.map((role) => ({
          userId: id,
          roleId: role.id,
        })),
      });
    });

    // Log audit event
    await this.createAuditEvent(adminUserId, 'user:roles_update', 'user', id, {
      newRoles: dto.roleNames,
    });

    this.logger.log(
      `User ${id} roles updated to [${dto.roleNames.join(', ')}] by admin ${adminUserId}`,
    );

    return this.getUserById(id);
  }

  /**
   * Create audit event
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        meta,
      },
    });
  }
}
```

### 4. Users Controller

Create `apps/api/src/users/users.controller.ts`:

```typescript
import {
  Controller,
  Get,
  Patch,
  Put,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { Auth, CurrentUser } from '../auth/decorators';
import { ROLES, PERMISSIONS } from '../common/constants/roles.constants';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USERS_READ] })
  @ApiOperation({ summary: 'List users (Admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['email', 'createdAt', 'updatedAt'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Paginated user list' })
  async listUsers(@Query() query: UserListQueryDto) {
    return this.usersService.listUsers(query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.USERS_READ] })
  @ApiOperation({ summary: 'Get user by ID (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'User details' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUserById(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getUserById(id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE] })
  @ApiOperation({ summary: 'Update user (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Updated user' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 403, description: 'Cannot deactivate self' })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.usersService.updateUser(id, dto, adminUserId);
  }

  @Put(':id/roles')
  @Auth({ permissions: [PERMISSIONS.RBAC_MANAGE] })
  @ApiOperation({ summary: 'Update user roles (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Updated user with new roles' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Invalid role names' })
  @ApiResponse({ status: 403, description: 'Cannot remove own admin role' })
  async updateUserRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRolesDto,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.usersService.updateUserRoles(id, dto, adminUserId);
  }
}
```

### 5. Users Module

Update `apps/api/src/users/users.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

---

## API Endpoints

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/api/users` | GET | users:read | List users (paginated) |
| `/api/users/:id` | GET | users:read | Get user details |
| `/api/users/:id` | PATCH | users:read, users:write | Update user |
| `/api/users/:id/roles` | PUT | rbac:manage | Update user roles |

---

## Query Parameters (List Users)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| pageSize | number | 20 | Items per page (max 100) |
| search | string | - | Search email/name |
| role | string | - | Filter by role name |
| isActive | boolean | - | Filter by active status |
| sortBy | string | createdAt | Sort field |
| sortOrder | string | desc | Sort direction |

---

## Acceptance Criteria

- [ ] `GET /api/users` returns paginated user list
- [ ] List supports search, role filter, and active filter
- [ ] `GET /api/users/:id` returns user with roles and identities
- [ ] `PATCH /api/users/:id` updates display name and active status
- [ ] Admin cannot deactivate their own account
- [ ] `PUT /api/users/:id/roles` replaces user roles
- [ ] Admin cannot remove admin role from themselves
- [ ] Invalid role names return 400 error
- [ ] All mutations create audit events
- [ ] Non-admin users get 403 Forbidden
- [ ] Swagger docs are complete

---

## Notes

- All endpoints require admin permissions
- Audit events track all admin actions
- Self-protection prevents admin from locking themselves out
- Role updates are atomic (all-or-nothing)
- Pagination prevents large response payloads
