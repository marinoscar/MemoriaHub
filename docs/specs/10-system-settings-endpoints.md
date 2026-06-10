# Spec 10: System Settings Endpoints

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 07-rbac-guards, 02-database-schema
**Estimated Complexity:** Medium

---

## Objective

Implement admin-only endpoints for managing system-wide application settings stored as JSONB with validation and audit logging.

---

## Deliverables

### 1. File Structure

```
apps/api/src/settings/
├── settings.module.ts
├── user-settings/        # (from spec 09)
└── system-settings/
    ├── system-settings.controller.ts
    └── system-settings.service.ts
```

### 2. DTOs

Create `apps/api/src/settings/dto/system-settings-response.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const systemSettingsResponseSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  security: z.object({
    jwtAccessTtlMinutes: z.number(),
    refreshTtlDays: z.number(),
  }),
  features: z.record(z.string(), z.boolean()),
  updatedAt: z.date(),
  updatedBy: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
    })
    .nullable(),
  version: z.number(),
});

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
```

Create `apps/api/src/settings/dto/update-system-settings.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Full replacement (PUT)
export const updateSystemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  security: z.object({
    jwtAccessTtlMinutes: z.number().int().min(1).max(60),
    refreshTtlDays: z.number().int().min(1).max(90),
  }),
  features: z.record(z.string(), z.boolean()),
});

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

// Partial update (PATCH)
export const patchSystemSettingsSchema = z.object({
  ui: z
    .object({
      allowUserThemeOverride: z.boolean().optional(),
    })
    .optional(),
  security: z
    .object({
      jwtAccessTtlMinutes: z.number().int().min(1).max(60).optional(),
      refreshTtlDays: z.number().int().min(1).max(90).optional(),
    })
    .optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
```

### 3. System Settings Service

Create `apps/api/src/settings/system-settings/system-settings.service.ts`:

```typescript
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSystemSettingsDto } from '../dto/update-system-settings.dto';
import { PatchSystemSettingsDto } from '../dto/update-system-settings.dto';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';
import { systemSettingsSchema } from '../../common/schemas/settings.schema';

const SETTINGS_KEY = 'global';

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get system settings
   * Creates default if not found (should exist from seed)
   */
  async getSettings() {
    let settings = await this.prisma.systemSettings.findUnique({
      where: { key: SETTINGS_KEY },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    if (!settings) {
      // Should have been seeded, but create if missing
      settings = await this.prisma.systemSettings.create({
        data: {
          key: SETTINGS_KEY,
          value: DEFAULT_SYSTEM_SETTINGS,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
      this.logger.warn('Created default system settings - seed may not have run');
    }

    const value = settings.value as SystemSettingsValue;

    return {
      ui: value.ui,
      security: value.security,
      features: value.features,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedByUser,
      version: settings.version,
    };
  }

  /**
   * Replace system settings (PUT)
   */
  async replaceSettings(dto: UpdateSystemSettingsDto, userId: string) {
    // Validate against schema
    const validated = systemSettingsSchema.parse(dto);

    const settings = await this.prisma.systemSettings.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: validated,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: SETTINGS_KEY,
        value: validated,
        updatedByUserId: userId,
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:replace', settings.id, {
      newValue: validated,
    });

    this.logger.log(`System settings replaced by user: ${userId}`);

    const value = settings.value as SystemSettingsValue;

    return {
      ui: value.ui,
      security: value.security,
      features: value.features,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedByUser,
      version: settings.version,
    };
  }

  /**
   * Partial update system settings (PATCH)
   */
  async patchSettings(
    dto: PatchSystemSettingsDto,
    userId: string,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings();

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Deep merge with existing settings
    const merged: SystemSettingsValue = {
      ui: {
        allowUserThemeOverride:
          dto.ui?.allowUserThemeOverride ?? current.ui.allowUserThemeOverride,
      },
      security: {
        jwtAccessTtlMinutes:
          dto.security?.jwtAccessTtlMinutes ?? current.security.jwtAccessTtlMinutes,
        refreshTtlDays:
          dto.security?.refreshTtlDays ?? current.security.refreshTtlDays,
      },
      features: {
        ...current.features,
        ...(dto.features || {}),
      },
    };

    // Validate merged result
    const validated = systemSettingsSchema.parse(merged);

    const settings = await this.prisma.systemSettings.update({
      where: { key: SETTINGS_KEY },
      data: {
        value: validated,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:patch', settings.id, {
      changes: dto,
      resultingValue: validated,
    });

    this.logger.log(`System settings patched by user: ${userId}`);

    const value = settings.value as SystemSettingsValue;

    return {
      ui: value.ui,
      security: value.security,
      features: value.features,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedByUser,
      version: settings.version,
    };
  }

  /**
   * Get a specific setting value
   */
  async getSettingValue<T>(path: string): Promise<T | undefined> {
    const settings = await this.getSettings();
    const parts = path.split('.');

    let value: any = settings;
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) break;
    }

    return value as T;
  }

  /**
   * Check if a feature flag is enabled
   */
  async isFeatureEnabled(featureName: string): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.features[featureName] ?? false;
  }

  /**
   * Create audit event
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'system_settings',
        targetId,
        meta,
      },
    });
  }
}
```

### 4. System Settings Controller

Create `apps/api/src/settings/system-settings/system-settings.controller.ts`:

```typescript
import {
  Controller,
  Get,
  Put,
  Patch,
  Body,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';

import { SystemSettingsService } from './system-settings.service';
import { Auth, CurrentUser } from '../../auth/decorators';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  UpdateSystemSettingsDto,
  PatchSystemSettingsDto,
} from '../dto/update-system-settings.dto';

@ApiTags('System Settings')
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get system settings (Admin only)' })
  @ApiResponse({ status: 200, description: 'System settings' })
  async getSettings() {
    return this.systemSettingsService.getSettings();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Replace system settings (Admin only)' })
  @ApiResponse({ status: 200, description: 'Updated settings' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async replaceSettings(
    @Body() dto: UpdateSystemSettingsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.systemSettingsService.replaceSettings(dto, userId);
  }

  @Patch()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Partially update system settings (Admin only)' })
  @ApiHeader({
    name: 'If-Match',
    description: 'Expected version for optimistic concurrency',
    required: false,
  })
  @ApiResponse({ status: 200, description: 'Updated settings' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async patchSettings(
    @Body() dto: PatchSystemSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;
    return this.systemSettingsService.patchSettings(dto, userId, expectedVersion);
  }
}
```

### 5. Update Settings Module

Update `apps/api/src/settings/settings.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { UserSettingsController } from './user-settings/user-settings.controller';
import { UserSettingsService } from './user-settings/user-settings.service';
import { SystemSettingsController } from './system-settings/system-settings.controller';
import { SystemSettingsService } from './system-settings/system-settings.service';

@Module({
  controllers: [UserSettingsController, SystemSettingsController],
  providers: [UserSettingsService, SystemSettingsService],
  exports: [UserSettingsService, SystemSettingsService],
})
export class SettingsModule {}
```

---

## API Endpoints

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/api/system-settings` | GET | system_settings:read | Get system settings |
| `/api/system-settings` | PUT | system_settings:write | Replace all settings |
| `/api/system-settings` | PATCH | system_settings:write | Partial update settings |

---

## Settings Schema

```typescript
interface SystemSettingsValue {
  ui: {
    allowUserThemeOverride: boolean;  // Allow users to override system theme
  };
  security: {
    jwtAccessTtlMinutes: number;      // Access token TTL (1-60)
    refreshTtlDays: number;           // Refresh token TTL (1-90)
  };
  features: {
    [key: string]: boolean;           // Feature flags
  };
}
```

---

## Request/Response Examples

### GET /api/system-settings

Response:
```json
{
  "data": {
    "ui": {
      "allowUserThemeOverride": true
    },
    "security": {
      "jwtAccessTtlMinutes": 15,
      "refreshTtlDays": 14
    },
    "features": {
      "newDashboard": false,
      "betaFeatures": true
    },
    "updatedAt": "2024-01-15T10:30:00Z",
    "updatedBy": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "admin@example.com"
    },
    "version": 5
  }
}
```

### PUT /api/system-settings

Request:
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 20,
    "refreshTtlDays": 7
  },
  "features": {
    "newDashboard": true
  }
}
```

### PATCH /api/system-settings

Request (toggle a feature flag):
```json
{
  "features": {
    "newDashboard": true
  }
}
```

Request (update security settings):
```json
{
  "security": {
    "jwtAccessTtlMinutes": 10
  }
}
```

---

## Audit Trail

All system settings changes are logged to `audit_events`:

```json
{
  "action": "system_settings:patch",
  "targetType": "system_settings",
  "targetId": "settings-uuid",
  "meta": {
    "changes": {
      "security": { "jwtAccessTtlMinutes": 10 }
    },
    "resultingValue": { /* full new value */ }
  }
}
```

---

## Acceptance Criteria

- [ ] `GET /api/system-settings` returns current settings
- [ ] Non-admin users get 403 Forbidden
- [ ] `PUT /api/system-settings` replaces all settings
- [ ] `PATCH /api/system-settings` merges with existing settings
- [ ] Security settings validated (TTL ranges)
- [ ] Feature flags support dynamic keys
- [ ] `updatedBy` tracks which admin made changes
- [ ] `If-Match` header enables optimistic concurrency
- [ ] All changes logged to audit_events
- [ ] Default settings created if missing
- [ ] Swagger docs complete

---

## Notes

- System settings are global (single row with key='global')
- Only admins can read/write system settings
- Security settings have constraints (min/max values)
- Feature flags allow dynamic boolean keys
- Audit trail provides accountability for changes
- Version field enables optimistic concurrency
