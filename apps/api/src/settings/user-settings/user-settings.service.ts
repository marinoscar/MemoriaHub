import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  DataTableLayoutValue,
  UserSettingsValue,
} from '../../common/types/settings.types';
import {
  DATA_TABLE_MAX_TABLES,
  userSettingsSchema,
} from '../../common/schemas/settings.schema';

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
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
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
        value: validated as any,
        version: { increment: 1 },
      },
      create: {
        userId,
        value: validated as any,
      },
    });

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
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
      search: dto.search !== undefined
        ? { visibleFields: dto.search.visibleFields }
        : current.search,
      dataTables: this.mergeDataTables(current.dataTables, dto.dataTables),
    };

    // The per-table-id merge above can push the namespace past its cap even
    // when the patch payload itself was under it. Enforce the real (post-merge)
    // bound here so it surfaces as a 400 rather than a raw ZodError -> 500.
    const tableCount = Object.keys(merged.dataTables ?? {}).length;
    if (tableCount > DATA_TABLE_MAX_TABLES) {
      throw new BadRequestException(
        `dataTables may hold at most ${DATA_TABLE_MAX_TABLES} table ids (patch would produce ${tableCount})`,
      );
    }

    // Validate merged result
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        value: validated as any,
        version: { increment: 1 },
      },
    });

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Merge a PATCH's `dataTables` payload into the stored namespace.
   *
   * The merge is **per table id**, one level deep:
   *   - a table id absent from the patch is left exactly as stored, so patching
   *     one table's layout never clobbers another's;
   *   - a table id present in the patch REPLACES that entry wholesale (same
   *     whole-object semantics `search` already has). This is what makes "reset
   *     this table to defaults" expressible: send `{ [tableId]: {} }` and every
   *     sub-key becomes absent again, rather than being stuck at whatever was
   *     last stored;
   *   - a table id mapped to `null` DELETES the entry (JSON Merge Patch), so a
   *     client can evict a table it no longer renders instead of holding a slot.
   *
   * An empty result collapses back to `undefined` — the namespace absent is the
   * canonical "nothing persisted" state, and storing `{}` would only be noise.
   */
  private mergeDataTables(
    current: Record<string, DataTableLayoutValue> | undefined,
    patch: Record<string, DataTableLayoutValue | null> | undefined,
  ): Record<string, DataTableLayoutValue> | undefined {
    if (patch === undefined) {
      return current;
    }

    const merged: Record<string, DataTableLayoutValue> = { ...(current ?? {}) };

    for (const [tableId, entry] of Object.entries(patch)) {
      if (entry === null) {
        delete merged[tableId];
      } else {
        merged[tableId] = entry;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
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
