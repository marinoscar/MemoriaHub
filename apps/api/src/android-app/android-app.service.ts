import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  ANDROID_APP_SETTINGS_KEY,
  ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
  androidAppSettingsValueSchema,
  buildAssetLinks,
  MAX_TRUSTED_ANDROID_APPS,
  normalizeSha256Fingerprint,
  trustedAndroidAppSchema,
  trustedAppKey,
  type AssetLinkStatement,
  type TrustedAndroidApp,
} from './android-app.schema';
import type { AndroidAppResponse, ReportedAndroidApp, UpdateAndroidAppInput } from './dto/android-app.dto';

// =============================================================================
// AndroidAppService (issue #503, epic #498)
// =============================================================================
//
// Owns the `android_app` system_settings row (the trusted apps), derives the
// Digital Asset Links document from it, and reads which apps paired devices
// actually report (`media_sync_devices.package_name` / `signing_sha256`,
// written by the Media Sync module when a phone registers, #505). It reads
// that table directly with one grouped SELECT rather than importing the module
// that owns its writes.
//
// Reads go straight through PrismaService, never SystemSettingsService (which
// only ever reads the `global` row) — the `webPush` row precedent.
//
// A MALFORMED STORED VALUE READS AS "NOTHING TRUSTED" rather than throwing:
// the public assetlinks route must keep answering, and the admin page must stay
// usable so the list can be saved again. The problem is logged.
//
// EXTENSION POINT (#504): making an APK release current calls
// `ensureTrusted(...)`, so the app that release installs opens without a URL
// bar. It never throws, so a full list cannot fail a release promotion.
// =============================================================================

@Injectable()
export class AndroidAppService {
  private readonly logger = new Logger(AndroidAppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The stored trusted apps; `[]` when nothing is stored or the row does not validate. */
  async getTrustedApps(): Promise<TrustedAndroidApp[]> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: ANDROID_APP_SETTINGS_KEY },
      select: { value: true },
    });

    if (!row) return [];

    const parsed = androidAppSettingsValueSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.warn(
        `Stored ${ANDROID_APP_SETTINGS_KEY} settings do not validate; treating as no trusted apps ` +
          `(${parsed.error.issues.length} issue(s)). Save the list again at PUT /api/admin/android-app.`,
      );
      return [];
    }

    return parsed.data.trustedApps;
  }

  /** The body of `/.well-known/assetlinks.json`. */
  async getAssetLinks(): Promise<AssetLinkStatement[]> {
    return buildAssetLinks(await this.getTrustedApps());
  }

  /**
   * Distinct (packageName, sha256) pairs reported by ACTIVE Media Sync
   * devices, with how many devices report each and when one was last seen.
   * Fingerprints are normalised (uppercase colon form), so a device reporting
   * lowercase or bare hex lands in the same row; package names are kept
   * exactly as reported. Most devices first, then by package name.
   */
  async getReportedApps(trusted: readonly TrustedAndroidApp[] = []): Promise<ReportedAndroidApp[]> {
    const groups = await this.prisma.mediaSyncDevice.groupBy({
      by: ['packageName', 'signingSha256'],
      where: {
        status: 'active',
        packageName: { not: null },
        signingSha256: { not: null },
      },
      _count: { _all: true },
      _max: { lastSeenAt: true },
    });

    const trustedKeys = new Set(trusted.map((app) => trustedAppKey(app.packageName, app.sha256)));
    const merged = new Map<
      string,
      { packageName: string; sha256: string; deviceCount: number; lastSeenAt: Date | null }
    >();

    for (const group of groups ?? []) {
      if (!group.packageName || !group.signingSha256) continue;

      const sha256 = normalizeSha256Fingerprint(group.signingSha256);
      const key = trustedAppKey(group.packageName, sha256);
      const lastSeenAt = group._max?.lastSeenAt ?? null;
      const count = (group._count as { _all?: number } | undefined)?._all ?? 0;
      const existing = merged.get(key);

      if (existing) {
        existing.deviceCount += count;
        if (lastSeenAt && (!existing.lastSeenAt || lastSeenAt > existing.lastSeenAt)) {
          existing.lastSeenAt = lastSeenAt;
        }
      } else {
        merged.set(key, { packageName: group.packageName, sha256, deviceCount: count, lastSeenAt });
      }
    }

    return [...merged.entries()]
      .map(([key, app]) => ({
        packageName: app.packageName,
        sha256: app.sha256,
        deviceCount: app.deviceCount,
        lastSeenAt: app.lastSeenAt ? app.lastSeenAt.toISOString() : null,
        trusted: trustedKeys.has(key),
      }))
      .sort(
        (a, b) =>
          b.deviceCount - a.deviceCount ||
          a.packageName.localeCompare(b.packageName) ||
          a.sha256.localeCompare(b.sha256),
      );
  }

  /** `GET /api/admin/android-app`. */
  async describe(): Promise<AndroidAppResponse> {
    const trustedApps = await this.getTrustedApps();
    const reportedApps = await this.getReportedApps(trustedApps);

    return {
      trustedApps,
      reportedApps,
      assetLinks: buildAssetLinks(trustedApps),
    };
  }

  /**
   * Adds (packageName, sha256) to the trusted apps when absent — called by
   * #504 when an uploaded APK release becomes current, so the app it installs
   * opens without a URL bar. Audited like a save.
   *
   * Returns true when the pair was added, false otherwise: already trusted
   * (idempotent, fingerprint compared however it is spelled), the list is
   * full (logged; an administrator must make room by hand), the input is not
   * a valid pair (logged), or the write failed (logged). NEVER THROWS, so a
   * trust problem can never fail the release promotion that triggered it.
   */
  async ensureTrusted(app: { packageName: string; sha256: string }, userId: string): Promise<boolean> {
    try {
      const parsed = trustedAndroidAppSchema.safeParse(app);
      if (!parsed.success) {
        this.logger.warn(
          `Not trusting ${String(app?.packageName)}: not a valid (packageName, sha256) pair ` +
            `(${parsed.error.issues.map((issue) => issue.message).join('; ')}).`,
        );
        return false;
      }
      const candidate = parsed.data;

      const before = await this.getTrustedApps();
      const key = trustedAppKey(candidate.packageName, candidate.sha256);
      if (before.some((existing) => trustedAppKey(existing.packageName, existing.sha256) === key)) {
        return false;
      }

      if (before.length >= MAX_TRUSTED_ANDROID_APPS) {
        this.logger.warn(
          `Not trusting ${candidate.packageName}: the trusted apps list is full (${MAX_TRUSTED_ANDROID_APPS}). ` +
            'Remove an entry at PUT /api/admin/android-app.',
        );
        return false;
      }

      await this.save(before, [...before, candidate], userId);
      return true;
    } catch (err) {
      this.logger.error(
        `Could not trust ${String(app?.packageName)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** `PUT /api/admin/android-app` — replace the list, audit the change, return the new state. */
  async replace(input: UpdateAndroidAppInput, userId: string): Promise<AndroidAppResponse> {
    const before = await this.getTrustedApps();
    await this.save(before, input.trustedApps, userId);
    return this.describe();
  }

  /** Writes the row, then the audit event naming what was added and removed. */
  private async save(
    before: readonly TrustedAndroidApp[],
    next: readonly TrustedAndroidApp[],
    userId: string,
  ): Promise<void> {
    const value = { trustedApps: next } as unknown as Prisma.InputJsonValue;

    await this.prisma.systemSettings.upsert({
      where: { key: ANDROID_APP_SETTINGS_KEY },
      update: { value, updatedByUserId: userId, version: { increment: 1 } },
      create: { key: ANDROID_APP_SETTINGS_KEY, value, updatedByUserId: userId },
    });

    const beforeKeys = new Set(before.map((app) => trustedAppKey(app.packageName, app.sha256)));
    const nextKeys = new Set(next.map((app) => trustedAppKey(app.packageName, app.sha256)));

    // Package names and certificate fingerprints are public by design (they
    // are what assetlinks.json publishes), so the audit row names them.
    // Best-effort, like the webPush audit: a completed write is not undone by
    // a failed audit insert.
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
          targetType: 'system_settings',
          targetId: ANDROID_APP_SETTINGS_KEY,
          meta: {
            count: next.length,
            added: next.filter((app) => !beforeKeys.has(trustedAppKey(app.packageName, app.sha256))),
            removed: before.filter((app) => !nextKeys.has(trustedAppKey(app.packageName, app.sha256))),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not record audit event ${ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(`Trusted Android apps saved by user ${userId} (${next.length} app(s))`);
  }
}
