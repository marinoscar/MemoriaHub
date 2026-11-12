import type { MediaModels } from '../data/media-db.js';

/**
 * What an active Media Sync device reports about the app it runs: one row per (package, signer) pair.
 *
 * @stability experimental
 */
export interface MediaSyncReportedApp {
  /** The Android application id the devices report. */
  packageName: string;
  /** The SHA-256 fingerprint of the signing certificate they report. */
  signingSha256: string;
  /** How many active devices report this pair. */
  deviceCount: number;
  /** The latest check-in among them, or null when none ever checked in. */
  lastSeenAt: Date | null;
}

/**
 * The (package, signer) pairs ACTIVE Media Sync devices report, counted per pair with the latest
 * `last_seen_at` per pair. A device that reported no package or no signer is not counted. The host's
 * Android app slice lists them on its admin page and warns about an untrusted one.
 *
 * @param prisma - the database port.
 * @stability experimental
 */
export async function mediaSyncReportedApps(prisma: Pick<MediaModels, 'mediaSyncDevice'>): Promise<MediaSyncReportedApp[]> {
  const groups = await prisma.mediaSyncDevice.groupBy({
    by: ['packageName', 'signingSha256'],
    where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
    _count: { _all: true },
    _max: { lastSeenAt: true },
  });
  const rows: MediaSyncReportedApp[] = [];
  for (const group of groups ?? []) {
    if (!group.packageName || !group.signingSha256) continue;
    const count = group._count;
    rows.push({
      packageName: group.packageName,
      signingSha256: group.signingSha256,
      deviceCount: typeof count === 'object' && count ? (count._all ?? 0) : 0,
      lastSeenAt: group._max?.lastSeenAt ?? null,
    });
  }
  return rows;
}

/**
 * How many ACTIVE Media Sync devices run an older build of `packageName` than `versionCode`, plus those
 * that never reported a package. A device running another package (a debug build) is not counted: the
 * current release cannot update it.
 *
 * @param prisma - the database port.
 * @param packageName - the current release's application id.
 * @param versionCode - the current release's version code.
 * @stability experimental
 */
export async function mediaSyncDevicesBehind(
  prisma: Pick<MediaModels, 'mediaSyncDevice'>,
  packageName: string,
  versionCode: number,
): Promise<number> {
  return prisma.mediaSyncDevice.count({
    where: {
      status: 'active',
      appVersionCode: { lt: versionCode },
      OR: [{ packageName }, { packageName: null }],
    },
  });
}
