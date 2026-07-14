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
  defaultStuckThresholdMinutes,
  defaultEmailSettings,
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
  dedup: SystemSettingsValue['dedup'];
  locationInference: SystemSettingsValue['locationInference'];
  socialMedia: SystemSettingsValue['socialMedia'];
  geo: SystemSettingsValue['geo'];
  email: SystemSettingsValue['email'];
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
      dedup: value.dedup,
      locationInference: value.locationInference,
      socialMedia: value.socialMedia,
      geo: value.geo,
      email: value.email,
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
      dedup: value.dedup,
      locationInference: value.locationInference,
      socialMedia: value.socialMedia,
      geo: value.geo,
      email: value.email,
      jobs: value.jobs,
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

    // Env-seeded defaults for the email block (used only to backfill absent keys).
    const emailDefaults = defaultEmailSettings();

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
        video: {
          enabled: (dto as any).face?.video?.enabled ?? (current as any).face?.video?.enabled ?? true,
          sampleIntervalSeconds: (dto as any).face?.video?.sampleIntervalSeconds ?? (current as any).face?.video?.sampleIntervalSeconds ?? 5,
          maxFramesPerVideo: (dto as any).face?.video?.maxFramesPerVideo ?? (current as any).face?.video?.maxFramesPerVideo ?? 60,
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
        autoResolveThreshold:
          (dto as any).burst?.autoResolveThreshold ??
          (current as any).burst?.autoResolveThreshold ??
          60,
      },
      dedup: {
        similarityThreshold:
          (dto as any).dedup?.similarityThreshold ??
          (current as any).dedup?.similarityThreshold ??
          0.96,
        hashMaxDistance:
          (dto as any).dedup?.hashMaxDistance ??
          (current as any).dedup?.hashMaxDistance ??
          6,
        knnCandidates:
          (dto as any).dedup?.knnCandidates ??
          (current as any).dedup?.knnCandidates ??
          20,
        autoResolveThreshold:
          (dto as any).dedup?.autoResolveThreshold ??
          (current as any).dedup?.autoResolveThreshold ??
          60,
      },
      locationInference: {
        maxGapMinutes:
          (dto as any).locationInference?.maxGapMinutes ??
          (current as any).locationInference?.maxGapMinutes ??
          30,
        maxExtrapolationGapMinutes:
          (dto as any).locationInference?.maxExtrapolationGapMinutes ??
          (current as any).locationInference?.maxExtrapolationGapMinutes ??
          10,
        autoApplyMaxGapMinutes:
          (dto as any).locationInference?.autoApplyMaxGapMinutes ??
          (current as any).locationInference?.autoApplyMaxGapMinutes ??
          5,
        requireSameDevice:
          (dto as any).locationInference?.requireSameDevice ??
          (current as any).locationInference?.requireSameDevice ??
          true,
        maxAnchorDistanceKm:
          (dto as any).locationInference?.maxAnchorDistanceKm ??
          (current as any).locationInference?.maxAnchorDistanceKm ??
          2,
        maxImpliedSpeedKmh:
          (dto as any).locationInference?.maxImpliedSpeedKmh ??
          (current as any).locationInference?.maxImpliedSpeedKmh ??
          150,
      },
      socialMedia: {
        ocrEnabled:
          (dto as any).socialMedia?.ocrEnabled ??
          (current as any).socialMedia?.ocrEnabled ??
          true,
        ocrLanguages:
          (dto as any).socialMedia?.ocrLanguages ??
          (current as any).socialMedia?.ocrLanguages ??
          ['eng'],
        ocrMaxFrames:
          (dto as any).socialMedia?.ocrMaxFrames ??
          (current as any).socialMedia?.ocrMaxFrames ??
          4,
        ocrTimeoutSeconds:
          (dto as any).socialMedia?.ocrTimeoutSeconds ??
          (current as any).socialMedia?.ocrTimeoutSeconds ??
          60,
        minConfidence:
          (dto as any).socialMedia?.minConfidence ??
          (current as any).socialMedia?.minConfidence ??
          0.8,
        maxDurationSeconds:
          (dto as any).socialMedia?.maxDurationSeconds ??
          (current as any).socialMedia?.maxDurationSeconds ??
          300,
        maxSizeBytes:
          (dto as any).socialMedia?.maxSizeBytes ??
          (current as any).socialMedia?.maxSizeBytes ??
          500_000_000,
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
      email: {
        provider:
          (dto as any).email?.provider !== undefined
            ? (dto as any).email?.provider
            : ((current as any).email?.provider ?? emailDefaults.provider),
        enabled:
          (dto as any).email?.enabled ??
          (current as any).email?.enabled ??
          emailDefaults.enabled,
        sesRegion:
          (dto as any).email?.sesRegion !== undefined
            ? (dto as any).email?.sesRegion
            : ((current as any).email?.sesRegion ?? emailDefaults.sesRegion),
        smtpHost:
          (dto as any).email?.smtpHost !== undefined
            ? (dto as any).email?.smtpHost
            : ((current as any).email?.smtpHost ?? emailDefaults.smtpHost),
        smtpPort:
          (dto as any).email?.smtpPort ??
          (current as any).email?.smtpPort ??
          emailDefaults.smtpPort,
        smtpUseTls:
          (dto as any).email?.smtpUseTls ??
          (current as any).email?.smtpUseTls ??
          emailDefaults.smtpUseTls,
        smtpUsername:
          (dto as any).email?.smtpUsername !== undefined
            ? (dto as any).email?.smtpUsername
            : ((current as any).email?.smtpUsername ?? emailDefaults.smtpUsername),
        // Preserve the stored ciphertext when the caller omits smtpPassword.
        smtpPassword:
          (dto as any).email?.smtpPassword ??
          (current as any).email?.smtpPassword ??
          emailDefaults.smtpPassword,
        fromAddress:
          (dto as any).email?.fromAddress !== undefined
            ? (dto as any).email?.fromAddress
            : ((current as any).email?.fromAddress ?? emailDefaults.fromAddress),
        fromName:
          (dto as any).email?.fromName !== undefined
            ? (dto as any).email?.fromName
            : ((current as any).email?.fromName ?? emailDefaults.fromName),
      },
      jobs: {
        history: {
          retentionDays:
            (dto as any).jobs?.history?.retentionDays ??
            (current as any).jobs?.history?.retentionDays ??
            30,
          purgeEnabled:
            (dto as any).jobs?.history?.purgeEnabled ??
            (current as any).jobs?.history?.purgeEnabled ??
            true,
        },
        stuckThresholdMinutes:
          (dto as any).jobs?.stuckThresholdMinutes ??
          (current as any).jobs?.stuckThresholdMinutes ??
          defaultStuckThresholdMinutes(),
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
      dedup: value.dedup,
      locationInference: value.locationInference,
      socialMedia: value.socialMedia,
      geo: value.geo,
      email: value.email,
      jobs: value.jobs,
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
