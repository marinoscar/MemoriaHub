// =============================================================================
// The Media Sync device source of the android-app slice (RETRO-D5, #586)
// =============================================================================
//
// The platform android-app slice owns no device table: each native capability
// registers a SOURCE that reports which (packageName, signingSha256) pairs its
// paired phones run (`registerAndroidDeviceSource`). MemoriaHub's one native
// capability is Media Sync, so its source groups `media_sync_devices`:
//
//   reportedApps()   ACTIVE devices that reported both a package name and a
//                    signer, counted per pair, latest `last_seen_at` per pair.
//                    The admin Android page lists them (trusted or not) and the
//                    slice's `android.assetlinks` Doctor check warns about an
//                    untrusted one. Same query the app's own AndroidAppService
//                    ran before the slice.
//   devicesBehind()  ACTIVE devices running an older versionCode of the
//                    current release's package, plus those that never reported
//                    a package (counted, as the app's `android.releases` check
//                    always did). A device running another package (a debug
//                    build) is not counted: the current release cannot update it.
//
// The registry is filled at IMPORT time (before the registries freeze), while a
// Prisma client only exists once Nest has built the module graph. So the source
// reads through a client bound later by `MediaSyncDeviceSourceBinder`
// (`onModuleInit`, provided by `MediaSyncModule`). Until it is bound (a test
// that never boots the module) the source reports nothing, which is exactly the
// "no paired device" answer.
//
// Imported by `platform/android-app/android-app.config.ts` (the slice's
// composition), guarded so a second import registers nothing twice.
// =============================================================================

import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  androidDeviceSourceRegistry,
  registerAndroidDeviceSource,
  type AndroidDeviceSource,
  type AndroidDeviceSourceRow,
} from '@marinoscar/platform-api/android-app';

import { PrismaService } from '../prisma/prisma.service';

/** The registry id of MemoriaHub's source (lower kebab case, permanent). */
export const MEDIA_SYNC_DEVICE_SOURCE_ID = 'media-sync';

/** The slice of the Prisma client the source reads. */
export type MediaSyncDeviceSourcePrisma = Pick<PrismaService, 'mediaSyncDevice'>;

let boundPrisma: MediaSyncDeviceSourcePrisma | null = null;

/** Binds (or, with `null`, unbinds) the client the source reads through. Exported for the specs. */
export function bindMediaSyncDeviceSource(prisma: MediaSyncDeviceSourcePrisma | null): void {
  boundPrisma = prisma;
}

/** The (package, signer) pairs active Media Sync devices report. */
export async function mediaSyncReportedApps(
  prisma: MediaSyncDeviceSourcePrisma | null = boundPrisma,
): Promise<AndroidDeviceSourceRow[]> {
  if (!prisma) return [];
  const groups = await prisma.mediaSyncDevice.groupBy({
    by: ['packageName', 'signingSha256'],
    where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
    _count: { _all: true },
    _max: { lastSeenAt: true },
  });
  const rows: AndroidDeviceSourceRow[] = [];
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

/** How many active Media Sync devices run an older build of `packageName` than `versionCode`. */
export async function mediaSyncDevicesBehind(
  packageName: string,
  versionCode: number,
  prisma: MediaSyncDeviceSourcePrisma | null = boundPrisma,
): Promise<number> {
  if (!prisma) return 0;
  return prisma.mediaSyncDevice.count({
    where: {
      status: 'active',
      appVersionCode: { lt: versionCode },
      OR: [{ packageName }, { packageName: null }],
    },
  });
}

/** The source as registered. */
export const MEDIA_SYNC_DEVICE_SOURCE: AndroidDeviceSource = Object.freeze({
  id: MEDIA_SYNC_DEVICE_SOURCE_ID,
  reportedApps: () => mediaSyncReportedApps(),
  devicesBehind: (packageName: string, versionCode: number) => mediaSyncDevicesBehind(packageName, versionCode),
});

/** Registers {@link MEDIA_SYNC_DEVICE_SOURCE} unless it already is (idempotent per process). */
export function registerMediaSyncDeviceSource(): void {
  if (androidDeviceSourceRegistry.has(MEDIA_SYNC_DEVICE_SOURCE_ID)) return;
  if (androidDeviceSourceRegistry.frozen) return;
  registerAndroidDeviceSource(MEDIA_SYNC_DEVICE_SOURCE);
}

registerMediaSyncDeviceSource();

/** Binds the application's Prisma client to the source once the module graph exists. */
@Injectable()
export class MediaSyncDeviceSourceBinder implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    bindMediaSyncDeviceSource(this.prisma);
  }
}
