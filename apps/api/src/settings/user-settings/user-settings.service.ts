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
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

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
