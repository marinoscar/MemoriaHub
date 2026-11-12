import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { DOCTOR_CHECK_TIMEOUT_MS, doctorCheckId, pass, skip, warn } from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_PRISMA,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';

/** Where an administrator manages trusted apps and APK releases. @stability experimental */
export const ANDROID_SETTINGS_PATH = '/admin/settings/android';

/**
 * A paired Android Media Sync device that has not checked in for this long is flagged by
 * `android.media-sync` (#507). The phone's WorkManager check-in runs at least every few hours; two days of
 * silence means it is off, uninstalled without unpairing, or blocked by the OS.
 *
 * @stability experimental
 */
export const ANDROID_DEVICE_STALE_HOURS = 48;

/** How many devices a single Android check names before eliding with "…". @stability experimental */
export const ANDROID_LIST_LIMIT_DEVICES = 5;

// Ported from `DoctorService.checkAndroidMediaSync` (key `android.mediaSync`).
// READ-ONLY: one `findMany` over `media_sync_devices` and one over the paired tokens.
//
// Active devices are checking in and able to upload. Warns on a device silent
// for more than 48 h, with blocked files, without full media permission, or
// whose paired PAT is revoked/expired/gone (the phone can no longer
// authenticate, so it will never check in again).
//
// PRIVACY NOTE: the detail names the device and its owner's email, as the old
// check did, because the remedy is to contact that owner. The report is
// admin-only (`system_settings:read`) and the support bundle's redaction pass
// removes email addresses.
// A domain check: the media slice's (Media Sync is MemoriaHub's domain), registered through
// `MEMORIAHUB_DOCTOR` under the permanent id `memoriahub.android.media-sync`.

/** One active device, with its paired token. @stability experimental */
export interface MediaSyncDeviceRow {
  name: string;
  lastSeenAt: Date | null;
  stats: unknown;
  permission: string | null;
  patId: string | null;
  pat: { revokedAt: Date | null; expiresAt: Date } | null;
  user: { email: string | null } | null;
}

/** `stats.blocked` from a device's last check-in, or 0 when absent/malformed. */
/** @stability experimental */
export function readBlockedCount(stats: unknown): number {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return 0;
  const blocked = (stats as Record<string, unknown>)['blocked'];
  return typeof blocked === 'number' && Number.isFinite(blocked) && blocked > 0 ? blocked : 0;
}

/** The status ladder of the `android.media-sync` check. @stability experimental */
export function decideAndroidMediaSync(devices: MediaSyncDeviceRow[], now: number): DoctorCheckOutcome {
  if (devices.length === 0) return skip('No active Media Sync device is paired.');

  const staleMs = ANDROID_DEVICE_STALE_HOURS * 3_600_000;
  const counts = { stale: 0, blocked: 0, permission: 0, credential: 0 };
  const flagged: string[] = [];

  for (const device of devices) {
    const reasons: string[] = [];

    if (!device.lastSeenAt || now - device.lastSeenAt.getTime() > staleMs) {
      counts.stale += 1;
      reasons.push(
        device.lastSeenAt
          ? `no check-in for ${Math.floor((now - device.lastSeenAt.getTime()) / 3_600_000)}h`
          : 'never checked in',
      );
    }

    const blocked = readBlockedCount(device.stats);
    if (blocked > 0) {
      counts.blocked += 1;
      reasons.push(`${blocked} blocked file(s)`);
    }

    // null = not reported yet (no check-in); the staleness rule covers that.
    if (device.permission !== null && device.permission !== 'full') {
      counts.permission += 1;
      reasons.push(`media permission ${device.permission}`);
    }

    const pat = device.pat;
    if (!device.patId || !pat || pat.revokedAt || pat.expiresAt.getTime() <= now) {
      counts.credential += 1;
      reasons.push(
        pat?.revokedAt ? 'token revoked' : pat && pat.expiresAt.getTime() <= now ? 'token expired' : 'no token',
      );
    }

    if (reasons.length > 0) {
      const owner = device.user?.email ? `, ${device.user.email}` : '';
      flagged.push(`${device.name}${owner}: ${reasons.join(', ')}`);
    }
  }

  if (flagged.length === 0) {
    return pass(
      `All ${devices.length} active device(s) checked in within ${ANDROID_DEVICE_STALE_HOURS}h with full media permission and no blocked files.`,
      { devices: devices.length },
    );
  }

  const tally = [
    counts.stale ? `${counts.stale} silent >${ANDROID_DEVICE_STALE_HOURS}h` : null,
    counts.blocked ? `${counts.blocked} with blocked files` : null,
    counts.permission ? `${counts.permission} without full media permission` : null,
    counts.credential ? `${counts.credential} with a revoked/expired token` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  const listed = flagged.slice(0, ANDROID_LIST_LIMIT_DEVICES).join('; ');
  const more = flagged.length > ANDROID_LIST_LIMIT_DEVICES ? '; …' : '';

  return warn(
    `${flagged.length} of ${devices.length} active device(s) need attention (${tally}): ${listed}${more}.`,
    'Ask the owner to open the app (Media Sync → Diagnostics) on each device: grant full photo/video access, ' +
      'resolve blocked files, or pair again if the token is gone. Owners see the details at /settings/media-sync.',
    {
      devices: devices.length,
      flagged: flagged.length,
      stale: counts.stale,
      blocked: counts.blocked,
      permission: counts.permission,
      credential: counts.credential,
    },
  );
}

/**
 * The `android.media-sync` check: paired devices that are silent, blocked, without full media permission
 * or without a usable token.
 *
 * @stability experimental
 */
@Injectable()
export class AndroidMediaSyncDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('android', 'media-sync');
  readonly category = 'android';
  readonly label = 'Media sync devices';
  readonly settingsPath = ANDROID_SETTINGS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const devices: Array<Omit<MediaSyncDeviceRow, 'pat'>> = await this.prisma.mediaSyncDevice.findMany({
      where: { status: 'active' },
      select: {
        name: true,
        lastSeenAt: true,
        stats: true,
        permission: true,
        patId: true,
        user: { select: { email: true } },
      },
      orderBy: { lastSeenAt: 'asc' },
    });
    // PLATFORM-ADOPTION-SHIM(RETRO-B2): the pat_id relation is not modelled; read the tokens in one query.
    const patIds = [...new Set(devices.map((d) => d.patId).filter((id): id is string => !!id))];
    const pats: Array<{ id: string; revokedAt: Date | null; expiresAt: Date }> = patIds.length
      ? await this.prisma.personalAccessToken.findMany({
          where: { id: { in: patIds } },
          select: { id: true, revokedAt: true, expiresAt: true },
        })
      : [];
    const byId = new Map(pats.map((p) => [p.id, { revokedAt: p.revokedAt, expiresAt: p.expiresAt }]));
    return decideAndroidMediaSync(
      devices.map((d) => ({ ...d, pat: d.patId ? (byId.get(d.patId) ?? null) : null })),
      Date.now(),
    );
  }
}
