# Spec 03: Database Seeds

**Domain:** Database
**Agent:** `database-dev`
**Depends On:** 02-database-schema
**Estimated Complexity:** Low

---

## Objective

Create seed data for roles, permissions, role-permission mappings, and default system settings. Implement admin bootstrap logic for initial admin user.

---

## Deliverables

### 1. Seed Script

Create `apps/api/prisma/seed.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// =============================================================================
// Seed Data Definitions
// =============================================================================

const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },
] as const;

// Role to permissions mapping
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
  ],
};

// Default system settings
const DEFAULT_SYSTEM_SETTINGS = {
  ui: {
    allowUserThemeOverride: true,
  },
  security: {
    jwtAccessTtlMinutes: 15,
    refreshTtlDays: 14,
  },
  features: {},
};

// =============================================================================
// Seed Functions
// =============================================================================

async function seedRoles() {
  console.log('Seeding roles...');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  console.log(`✓ Seeded ${ROLES.length} roles`);
}

async function seedPermissions() {
  console.log('Seeding permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: { description: permission.description },
      create: permission,
    });
  }

  console.log(`✓ Seeded ${PERMISSIONS.length} permissions`);
}

async function seedRolePermissions() {
  console.log('Seeding role-permission mappings...');

  let count = 0;

  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permissionName of permissionNames) {
      const permission = await prisma.permission.findUnique({
        where: { name: permissionName },
      });
      if (!permission) continue;

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
      count++;
    }
  }

  console.log(`✓ Seeded ${count} role-permission mappings`);
}

async function seedSystemSettings() {
  console.log('Seeding system settings...');

  await prisma.systemSettings.upsert({
    where: { key: 'global' },
    update: {}, // Don't overwrite existing settings
    create: {
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS,
      version: 1,
    },
  });

  console.log('✓ Seeded default system settings');
}

// =============================================================================
// Main Seed Function
// =============================================================================

async function main() {
  console.log('Starting database seed...\n');

  await seedRoles();
  await seedPermissions();
  await seedRolePermissions();
  await seedSystemSettings();

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

### 2. Update `package.json`

Add to `apps/api/package.json`:

```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  }
}
```

### 3. Admin Bootstrap Service

Create `apps/api/src/common/services/admin-bootstrap.service.ts`:

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // Only run in development or when explicitly enabled
    if (this.config.get('NODE_ENV') === 'production') {
      this.logger.log('Admin bootstrap disabled in production');
      return;
    }

    await this.ensureInitialAdminRole();
  }

  /**
   * Ensures the initial admin email (from env) has admin role assigned
   * when they first log in. This is handled during OAuth callback.
   */
  private async ensureInitialAdminRole() {
    const initialAdminEmail = this.config.get<string>('INITIAL_ADMIN_EMAIL');

    if (!initialAdminEmail) {
      this.logger.warn(
        'INITIAL_ADMIN_EMAIL not set - no admin will be auto-assigned',
      );
      return;
    }

    this.logger.log(
      `Admin bootstrap configured for: ${initialAdminEmail}`,
    );
  }

  /**
   * Called during OAuth callback to check if user should be granted admin
   */
  async shouldGrantAdminRole(email: string): Promise<boolean> {
    const initialAdminEmail = this.config.get<string>('INITIAL_ADMIN_EMAIL');

    if (!initialAdminEmail) {
      return false;
    }

    // Check if any admin already exists
    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
      include: {
        userRoles: {
          include: { user: true },
        },
      },
    });

    if (!adminRole) {
      return false;
    }

    const existingAdmins = adminRole.userRoles.filter(
      (ur) => ur.user.isActive,
    );

    // Only grant admin if:
    // 1. Email matches INITIAL_ADMIN_EMAIL
    // 2. No other active admins exist
    if (existingAdmins.length === 0 && email === initialAdminEmail) {
      this.logger.log(`Granting admin role to initial admin: ${email}`);
      return true;
    }

    return false;
  }

  /**
   * Assigns admin role to a user
   */
  async assignAdminRole(userId: string): Promise<void> {
    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
    });

    if (!adminRole) {
      throw new Error('Admin role not found - run seeds first');
    }

    await this.prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId,
          roleId: adminRole.id,
        },
      },
      update: {},
      create: {
        userId,
        roleId: adminRole.id,
      },
    });

    this.logger.log(`Admin role assigned to user: ${userId}`);
  }
}
```

### 4. Constants File

Create `apps/api/src/common/constants/roles.constants.ts`:

```typescript
// =============================================================================
// Role Constants
// =============================================================================

export const ROLES = {
  ADMIN: 'admin',
  CONTRIBUTOR: 'contributor',
  VIEWER: 'viewer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

// =============================================================================
// Permission Constants
// =============================================================================

export const PERMISSIONS = {
  // System settings
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',

  // User settings
  USER_SETTINGS_READ: 'user_settings:read',
  USER_SETTINGS_WRITE: 'user_settings:write',

  // Users
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',

  // RBAC
  RBAC_MANAGE: 'rbac:manage',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// =============================================================================
// Default Role
// =============================================================================

export const DEFAULT_ROLE = ROLES.VIEWER;
```

---

## Running Seeds

```bash
cd apps/api

# Run seeds (after migrations are applied)
npx prisma db seed

# Or reset DB and re-seed
npx prisma migrate reset
```

---

## Verification Queries

After seeding, verify with:

```sql
-- Check roles
SELECT * FROM roles;

-- Check permissions
SELECT * FROM permissions;

-- Check role-permission mappings
SELECT r.name as role, p.name as permission
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
ORDER BY r.name, p.name;

-- Check system settings
SELECT * FROM system_settings WHERE key = 'global';
```

Expected output:

| Role        | Permissions                                                                                           |
|-------------|-------------------------------------------------------------------------------------------------------|
| admin       | system_settings:read, system_settings:write, user_settings:read, user_settings:write, users:read, users:write, rbac:manage |
| contributor | user_settings:read, user_settings:write                                                               |
| viewer      | user_settings:read, user_settings:write                                                               |

---

## Acceptance Criteria

- [ ] `npx prisma db seed` runs without errors
- [ ] All 3 roles created: admin, contributor, viewer
- [ ] All 7 permissions created
- [ ] Role-permission mappings match specification
- [ ] System settings row exists with key='global'
- [ ] AdminBootstrapService checks INITIAL_ADMIN_EMAIL correctly
- [ ] Re-running seed is idempotent (upsert behavior)

---

## Notes

- Seeds use `upsert` to be idempotent
- Admin bootstrap only assigns role on first login when no admins exist
- Default role for new users is `viewer` (least privilege)
- System settings seed won't overwrite existing values
