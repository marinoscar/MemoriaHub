# Spec 09: User Settings Endpoints

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 07-rbac-guards, 02-database-schema
**Estimated Complexity:** Medium

---

## Objective

Implement endpoints for users to read and update their own settings including theme preferences and profile overrides.

---

## Deliverables

### 1. File Structure

```
apps/api/src/settings/
├── settings.module.ts
├── user-settings/
│   ├── user-settings.controller.ts
│   └── user-settings.service.ts
└── dto/
    ├── user-settings-response.dto.ts
    └── update-user-settings.dto.ts
```

### 2. DTOs

Create `apps/api/src/settings/dto/user-settings-response.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const userSettingsResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().nullable().optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
  updatedAt: z.date(),
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
```

Create `apps/api/src/settings/dto/update-user-settings.dto.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Full replacement (PUT)
export const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
});

export class UpdateUserSettingsDto extends createZodDto(
  updateUserSettingsSchema,
) {}

// Partial update (PATCH) - JSON Merge Patch style
export const patchUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  profile: z
    .object({
      displayName: z.string().max(100).optional(),
      useProviderImage: z.boolean().optional(),
      customImageUrl: z.string().url().nullable().optional(),
    })
    .optional(),
});

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
```

### 3. User Settings Service

Create `apps/api/src/settings/user-settings/user-settings.service.ts`:

```typescript
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';
import { userSettingsSchema } from '../../common/schemas/settings.schema';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get user settings for current user
   * Creates default settings if none exist
   */
  async getSettings(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if not found
    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId,
          value: DEFAULT_USER_SETTINGS,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Replace user settings (PUT)
   */
  async replaceSettings(userId: string, dto: UpdateUserSettingsDto) {
    // Validate against schema
    const validated = userSettingsSchema.parse(dto);

    const settings = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {
        value: validated,
        version: { increment: 1 },
      },
      create: {
        userId,
        value: validated,
      },
    });

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Partial update user settings (PATCH)
   * Uses JSON Merge Patch semantics
   */
  async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings(userId);

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Merge with existing settings
    const merged: UserSettingsValue = {
      theme: dto.theme ?? current.theme,
      profile: {
        displayName:
          dto.profile?.displayName !== undefined
            ? dto.profile.displayName
            : current.profile.displayName,
        useProviderImage:
          dto.profile?.useProviderImage !== undefined
            ? dto.profile.useProviderImage
            : current.profile.useProviderImage,
        customImageUrl:
          dto.profile?.customImageUrl !== undefined
            ? dto.profile.customImageUrl
            : current.profile.customImageUrl,
      },
    };

    // Validate merged result
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        value: validated,
        version: { increment: 1 },
      },
    });

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Sync display name from settings to user table
   */
  private async syncDisplayName(
    userId: string,
    displayName: string | undefined,
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: displayName || null },
    });
  }

  /**
   * Update profile image preference
   */
  async updateProfileImage(
    userId: string,
    useProviderImage: boolean,
    customImageUrl?: string | null,
  ) {
    return this.patchSettings(userId, {
      profile: {
        useProviderImage,
        customImageUrl,
      },
    });
  }

  /**
   * Update theme preference
   */
  async updateTheme(userId: string, theme: 'light' | 'dark' | 'system') {
    return this.patchSettings(userId, { theme });
  }
}
```

### 4. User Settings Controller

Create `apps/api/src/settings/user-settings/user-settings.controller.ts`:

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

import { UserSettingsService } from './user-settings.service';
import { Auth, CurrentUser } from '../../auth/decorators';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  UpdateUserSettingsDto,
  PatchUserSettingsDto,
} from '../dto/update-user-settings.dto';

@ApiTags('User Settings')
@Controller('user-settings')
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get current user settings' })
  @ApiResponse({ status: 200, description: 'User settings' })
  async getSettings(@CurrentUser('id') userId: string) {
    return this.userSettingsService.getSettings(userId);
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Replace user settings' })
  @ApiResponse({ status: 200, description: 'Updated settings' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async replaceSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserSettingsDto,
  ) {
    return this.userSettingsService.replaceSettings(userId, dto);
  }

  @Patch()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Partially update user settings' })
  @ApiHeader({
    name: 'If-Match',
    description: 'Expected version for optimistic concurrency',
    required: false,
  })
  @ApiResponse({ status: 200, description: 'Updated settings' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async patchSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: PatchUserSettingsDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;
    return this.userSettingsService.patchSettings(
      userId,
      dto,
      expectedVersion,
    );
  }
}
```

### 5. Settings Module

Update `apps/api/src/settings/settings.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { UserSettingsController } from './user-settings/user-settings.controller';
import { UserSettingsService } from './user-settings/user-settings.service';

@Module({
  controllers: [UserSettingsController],
  providers: [UserSettingsService],
  exports: [UserSettingsService],
})
export class SettingsModule {}
```

---

## API Endpoints

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/api/user-settings` | GET | user_settings:read | Get current user's settings |
| `/api/user-settings` | PUT | user_settings:write | Replace all settings |
| `/api/user-settings` | PATCH | user_settings:write | Partial update settings |

---

## Request/Response Examples

### GET /api/user-settings

Response:
```json
{
  "data": {
    "theme": "dark",
    "profile": {
      "displayName": "John Doe",
      "useProviderImage": true,
      "customImageUrl": null
    },
    "updatedAt": "2024-01-15T10:30:00Z",
    "version": 3
  }
}
```

### PUT /api/user-settings

Request:
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  }
}
```

### PATCH /api/user-settings

Request (only update theme):
```json
{
  "theme": "system"
}
```

Request (only update profile):
```json
{
  "profile": {
    "useProviderImage": true
  }
}
```

With optimistic concurrency:
```
PATCH /api/user-settings
If-Match: 3
```

---

## Optimistic Concurrency

The `If-Match` header enables optimistic concurrency control:

1. Client fetches settings, receives `version: 3`
2. Client sends PATCH with `If-Match: 3`
3. If version still 3, update succeeds with `version: 4`
4. If version changed (e.g., 4), returns 409 Conflict
5. Client re-fetches and retries

---

## Acceptance Criteria

- [ ] `GET /api/user-settings` returns current user's settings
- [ ] Default settings created if none exist
- [ ] `PUT /api/user-settings` replaces all settings
- [ ] `PATCH /api/user-settings` merges with existing settings
- [ ] Theme validated as 'light', 'dark', or 'system'
- [ ] Display name synced to user table
- [ ] Custom image URL validated as valid URL
- [ ] Version incremented on each update
- [ ] `If-Match` header enables optimistic concurrency
- [ ] Version mismatch returns 409 Conflict
- [ ] Users can only access their own settings
- [ ] Swagger docs complete

---

## Notes

- Settings are scoped to authenticated user only
- Default settings ensure every user has valid settings
- Display name syncs to user table for consistent display
- Version field enables optimistic concurrency control
- PATCH uses JSON Merge Patch semantics (RFC 7396)
