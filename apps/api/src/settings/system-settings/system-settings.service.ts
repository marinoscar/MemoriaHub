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

/** TTL for the in-memory settings cache in milliseconds. */
const SETTINGS_CACHE_TTL_MS = 5000;

/** Shape of the resolved settings object returned by getSettings(). */
export interface ResolvedSettings {
  ui: SystemSettingsValue['ui'];
  features: SystemSettingsValue['features'];
  ai: SystemSettingsValue['ai'];
  face: SystemSettingsValue['face'];
  storage: SystemSettingsValue['storage'];
  burst: SystemSettingsValue['burst'];
  geo: SystemSettingsValue['geo'];
  jobs: SystemSettingsValue['jobs'];
  updatedAt: Date;
  updatedBy: { id: string; email: string } | null;
  version: number;
}

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  /** In-process TTL cache — avoids repeated DB reads during bulk imports. */
  private settingsCache: {
    value: ResolvedSettings;
    cachedAt: number;
  } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Invalidate the in-memory settings cache.
   * Call after any write so that the next read fetches fresh data.
   */
  private invalidateSettingsCache(): void {
    this.settingsCache = null;
  }

  /**
   * Get system settings.
   * Results are cached in-process for SETTINGS_CACHE_TTL_MS (5 s) to avoid
   * a DB round-trip on every isFeatureEnabled call during bulk imports.
   * The cache is invalidated immediately on any write (replaceSettings /
   * patchSettings) so flag changes take effect on the very next read.
   * Creates default if not found (should exist from seed).
   */
  async getSettings() {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.cachedAt < SETTINGS_CACHE_TTL_MS) {
      return this.settingsCache.value;
    }

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
          value: DEFAULT_SYSTEM_SETTINGS as any,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
      this.logger.warn('Created default system settings - seed may not have run');
    }

    const value = settings.value as unknown as SystemSettingsValue;

    const result = {
      ui: value.ui,
      features: value.features,
      ai: value.ai,
      face: value.face,
      storage: value.storage,
      burst: value.burst,
      geo: value.geo,
      jobs: value.jobs,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedByUser,
      version: settings.version,
    };

    // Store in cache for fast subsequent reads within the TTL window.
    this.settingsCache = { value: result, cachedAt: Date.now() };

    return result;
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
        value: validated as any,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: SETTINGS_KEY,
        value: validated as any,
        updatedByUserId: userId,
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Invalidate cache so the next read fetches the new value immediately.
    this.invalidateSettingsCache();

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:replace', settings.id, {
      newValue: validated,
    });

    this.logger.log(`System settings replaced by user: ${userId}`);

    const value = settings.value as unknown as SystemSettingsValue;

    return {
      ui: value.ui,
      features: value.features,
      ai: value.ai,
      face: value.face,
      storage: value.storage,
      burst: value.burst,
      geo: value.geo,
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
      features: {
        ...current.features,
        ...(dto.features || {}),
      },
      ai: {
        features: {
          search: {
            provider: (dto as any).ai?.features?.search?.provider ?? current.ai?.features?.search?.provider ?? null,
            model: (dto as any).ai?.features?.search?.model ?? current.ai?.features?.search?.model ?? null,
          },
          tagging: {
            provider: (dto as any).ai?.features?.tagging?.provider ?? current.ai?.features?.tagging?.provider ?? null,
            model: (dto as any).ai?.features?.tagging?.model ?? current.ai?.features?.tagging?.model ?? null,
          },
          embedding: {
            provider: (dto as any).ai?.features?.embedding?.provider ?? current.ai?.features?.embedding?.provider ?? null,
            model: (dto as any).ai?.features?.embedding?.model ?? current.ai?.features?.embedding?.model ?? null,
          },
        },
      },
      face: {
        features: {
          detection: {
            provider: (dto as any).face?.features?.detection?.provider ?? current.face?.features?.detection?.provider ?? null,
            model: (dto as any).face?.features?.detection?.model ?? current.face?.features?.detection?.model ?? null,
          },
        },
      },
      storage: {
        activeProvider:
          (dto as any).storage?.activeProvider ??
          (current as any).storage?.activeProvider ??
          process.env['STORAGE_PROVIDER'] ??
          's3',
        insights: {
          refreshIntervalHours:
            (dto as any).storage?.insights?.refreshIntervalHours ??
            (current as any).storage?.insights?.refreshIntervalHours ??
            4,
        },
        trash: {
          retentionDays:
            (dto as any).storage?.trash?.retentionDays ??
            (current as any).storage?.trash?.retentionDays ??
            30,
        },
      },
      burst: {
        timeGapSeconds:
          (dto as any).burst?.timeGapSeconds ??
          (current as any).burst?.timeGapSeconds ??
          10,
        hashDistance:
          (dto as any).burst?.hashDistance ??
          (current as any).burst?.hashDistance ??
          10,
        minGroupSize:
          (dto as any).burst?.minGroupSize ??
          (current as any).burst?.minGroupSize ??
          3,
      },
      geo: {
        reverseProvider:
          (dto as any).geo?.reverseProvider ??
          (current as any).geo?.reverseProvider ??
          (process.env['GEO_PROVIDER'] === 'nominatim' ? 'nominatim' : 'offline'),
        forwardSearchEnabled:
          (dto as any).geo?.forwardSearchEnabled ??
          (current as any).geo?.forwardSearchEnabled ??
          (process.env['GEO_FORWARD_SEARCH_ENABLED'] === 'true'),
      },
    };

    // Validate merged result
    const validated = systemSettingsSchema.parse(merged);

    const settings = await this.prisma.systemSettings.update({
      where: { key: SETTINGS_KEY },
      data: {
        value: validated as any,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      include: {
        updatedByUser: {
          select: { id: true, email: true },
        },
      },
    });

    // Invalidate cache so the next read fetches the new value immediately.
    this.invalidateSettingsCache();

    // Create audit event
    await this.createAuditEvent(userId, 'system_settings:patch', settings.id, {
      changes: dto,
      resultingValue: validated,
    });

    this.logger.log(`System settings patched by user: ${userId}`);

    const value = settings.value as unknown as SystemSettingsValue;

    return {
      ui: value.ui,
      features: value.features,
      ai: value.ai,
      face: value.face,
      storage: value.storage,
      burst: value.burst,
      geo: value.geo,
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
        meta: meta as any,
      },
    });
  }
}
