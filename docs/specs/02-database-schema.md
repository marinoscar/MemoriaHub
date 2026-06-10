# Spec 02: Database Schema

**Domain:** Database
**Agent:** `database-dev`
**Depends On:** 01-project-setup
**Estimated Complexity:** Medium

---

## Objective

Create the Prisma schema with all required tables for users, identities, RBAC, settings, and audit logging. Generate the initial migration.

---

## Deliverables

### 1. Prisma Schema File

Create `apps/api/prisma/schema.prisma`:

```prisma
// =============================================================================
// Prisma Schema - Enterprise App Foundation
// =============================================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// =============================================================================
// User & Identity
// =============================================================================

model User {
  id                      String    @id @default(uuid()) @db.Uuid
  email                   String    @unique
  displayName             String?   @map("display_name")
  providerDisplayName     String?   @map("provider_display_name")
  profileImageUrl         String?   @map("profile_image_url")
  providerProfileImageUrl String?   @map("provider_profile_image_url")
  isActive                Boolean   @default(true) @map("is_active")
  createdAt               DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt               DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  // Relations
  identities      UserIdentity[]
  userRoles       UserRole[]
  userSettings    UserSettings?
  auditEvents     AuditEvent[]   @relation("ActorEvents")
  settingsUpdates SystemSettings[] @relation("SettingsUpdater")

  @@map("users")
}

model UserIdentity {
  id              String   @id @default(uuid()) @db.Uuid
  userId          String   @map("user_id") @db.Uuid
  provider        String
  providerSubject String   @map("provider_subject")
  providerEmail   String?  @map("provider_email")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerSubject])
  @@map("user_identities")
}

// =============================================================================
// RBAC - Roles & Permissions
// =============================================================================

model Role {
  id          String   @id @default(uuid()) @db.Uuid
  name        String   @unique
  description String?

  // Relations
  rolePermissions RolePermission[]
  userRoles       UserRole[]

  @@map("roles")
}

model Permission {
  id          String   @id @default(uuid()) @db.Uuid
  name        String   @unique
  description String?

  // Relations
  rolePermissions RolePermission[]

  @@map("permissions")
}

model RolePermission {
  roleId       String @map("role_id") @db.Uuid
  permissionId String @map("permission_id") @db.Uuid

  // Relations
  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
  @@map("role_permissions")
}

model UserRole {
  userId String @map("user_id") @db.Uuid
  roleId String @map("role_id") @db.Uuid

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  role Role @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@id([userId, roleId])
  @@map("user_roles")
}

// =============================================================================
// Settings
// =============================================================================

model SystemSettings {
  id              String   @id @default(uuid()) @db.Uuid
  key             String   @unique
  value           Json
  version         Int      @default(1)
  updatedByUserId String?  @map("updated_by_user_id") @db.Uuid
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  // Relations
  updatedByUser User? @relation("SettingsUpdater", fields: [updatedByUserId], references: [id], onDelete: SetNull)

  @@map("system_settings")
}

model UserSettings {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @unique @map("user_id") @db.Uuid
  value     Json
  version   Int      @default(1)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_settings")
}

// =============================================================================
// Audit
// =============================================================================

model AuditEvent {
  id          String   @id @default(uuid()) @db.Uuid
  actorUserId String?  @map("actor_user_id") @db.Uuid
  action      String
  targetType  String   @map("target_type")
  targetId    String   @map("target_id")
  meta        Json?
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  // Relations
  actorUser User? @relation("ActorEvents", fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([actorUserId])
  @@index([targetType, targetId])
  @@index([createdAt])
  @@map("audit_events")
}

// =============================================================================
// Refresh Tokens (for token rotation)
// =============================================================================

model RefreshToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  tokenHash String   @unique @map("token_hash")
  expiresAt DateTime @map("expires_at") @db.Timestamptz
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz

  @@index([userId])
  @@index([expiresAt])
  @@map("refresh_tokens")
}
```

### 2. TypeScript Types

Create `apps/api/src/common/types/settings.types.ts`:

```typescript
// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
}

/**
 * System settings schema - stored in system_settings.value JSONB
 */
export interface SystemSettingsValue {
  ui: {
    allowUserThemeOverride: boolean;
  };
  security: {
    jwtAccessTtlMinutes: number;
    refreshTtlDays: number;
  };
  features: {
    [key: string]: boolean;
  };
}

/**
 * Default user settings
 */
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    useProviderImage: true,
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  ui: {
    allowUserThemeOverride: true,
  },
  security: {
    jwtAccessTtlMinutes: 15,
    refreshTtlDays: 14,
  },
  features: {},
};
```

### 3. Zod Validation Schemas

Create `apps/api/src/common/schemas/settings.schema.ts`:

```typescript
import { z } from 'zod';

// =============================================================================
// User Settings Schema
// =============================================================================

export const userSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
});

export type UserSettingsDto = z.infer<typeof userSettingsSchema>;

// Partial schema for PATCH operations
export const userSettingsPatchSchema = userSettingsSchema.deepPartial();

// =============================================================================
// System Settings Schema
// =============================================================================

export const systemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  security: z.object({
    jwtAccessTtlMinutes: z.number().int().min(1).max(60),
    refreshTtlDays: z.number().int().min(1).max(90),
  }),
  features: z.record(z.string(), z.boolean()),
});

export type SystemSettingsDto = z.infer<typeof systemSettingsSchema>;

// Partial schema for PATCH operations
export const systemSettingsPatchSchema = systemSettingsSchema.deepPartial();
```

---

## Migration Commands

After creating the schema, run:

```bash
cd apps/api

# Generate Prisma client
npx prisma generate

# Create initial migration
npx prisma migrate dev --name init

# Apply migration (for existing DBs)
npx prisma migrate deploy
```

---

## Database Diagram (Reference)

```
┌─────────────────┐     ┌─────────────────┐
│     users       │     │ user_identities │
├─────────────────┤     ├─────────────────┤
│ id (PK)         │←────│ user_id (FK)    │
│ email (UNIQUE)  │     │ provider        │
│ display_name    │     │ provider_subject│
│ provider_*      │     └─────────────────┘
│ is_active       │
│ timestamps      │     ┌─────────────────┐
└────────┬────────┘     │   user_roles    │
         │              ├─────────────────┤
         └──────────────│ user_id (FK)    │
                        │ role_id (FK)    │
┌─────────────────┐     └────────┬────────┘
│     roles       │              │
├─────────────────┤              │
│ id (PK)         │←─────────────┘
│ name (UNIQUE)   │
│ description     │     ┌─────────────────┐
└────────┬────────┘     │role_permissions │
         │              ├─────────────────┤
         └──────────────│ role_id (FK)    │
                        │ permission_id   │
┌─────────────────┐     └────────┬────────┘
│   permissions   │              │
├─────────────────┤              │
│ id (PK)         │←─────────────┘
│ name (UNIQUE)   │
│ description     │
└─────────────────┘

┌─────────────────┐     ┌─────────────────┐
│ system_settings │     │  user_settings  │
├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │
│ key (UNIQUE)    │     │ user_id (UNIQUE)│
│ value (JSONB)   │     │ value (JSONB)   │
│ version         │     │ version         │
│ updated_by_user │     │ updated_at      │
└─────────────────┘     └─────────────────┘

┌─────────────────┐     ┌─────────────────┐
│  audit_events   │     │ refresh_tokens  │
├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │
│ actor_user_id   │     │ user_id (FK)    │
│ action          │     │ token_hash      │
│ target_type     │     │ expires_at      │
│ target_id       │     │ revoked_at      │
│ meta (JSONB)    │     └─────────────────┘
│ created_at      │
└─────────────────┘
```

---

## Acceptance Criteria

- [ ] `schema.prisma` compiles without errors
- [ ] `prisma generate` creates client successfully
- [ ] `prisma migrate dev` creates migration file
- [ ] All tables created with correct columns and constraints
- [ ] Foreign key relationships work correctly
- [ ] JSONB columns accept valid JSON
- [ ] Indexes created on audit_events and refresh_tokens
- [ ] TypeScript types match Prisma schema
- [ ] Zod schemas validate settings correctly

---

## Notes

- Use `@db.Uuid` for all ID fields for PostgreSQL UUID type
- Use `@db.Timestamptz` for timezone-aware timestamps
- All table/column names use snake_case via `@@map`
- Cascade deletes configured for dependent records
- Settings versioning allows optimistic concurrency
