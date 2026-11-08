import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { AndroidReleaseService } from '../../../android-app/releases/android-release.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip, warn } from '../outcome';
import { ANDROID_SETTINGS_HINT, ANDROID_SETTINGS_PATH } from './constants';

// Ported from `DoctorService.checkAndroidReleases` (key `android.releases`).
// READ-ONLY: two counts and the current release lookup. The pass detail carries
// `devicesBehind`, the only "devices behind" figure an administrator sees
// (spec D19): an update is the user's act, not a fault.
// Retirement: replaced by the android-app slice's check (RETRO-D5).

export interface ReleasesFacts {
  activeDevices: number;
  current: { versionName: string; versionCode: number } | null;
  devicesBehind: number;
}

export function decideAndroidReleases(f: ReleasesFacts): DoctorCheckOutcome {
  if (f.activeDevices === 0) return skip('No active Media Sync device is paired.');

  if (!f.current) {
    return warn(
      `${f.activeDevices} active device(s) are paired but no Android release is current, so phones cannot download or update the app from this server.`,
      `Publish one with \`memoriahub android release\` or upload it in ${ANDROID_SETTINGS_HINT}.`,
      { activeDevices: f.activeDevices },
    );
  }

  return pass(
    `Current release ${f.current.versionName} (${f.current.versionCode}); ` +
      `devicesBehind: ${f.devicesBehind} of ${f.activeDevices} active device(s) run an older build.`,
    { devicesBehind: f.devicesBehind, activeDevices: f.activeDevices, versionCode: f.current.versionCode },
  );
}

@Injectable()
export class AndroidReleasesDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('android', 'releases');
  readonly category = 'android';
  readonly label = 'Android release';
  readonly settingsPath = ANDROID_SETTINGS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly androidReleases: AndroidReleaseService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const [activeDevices, current] = await Promise.all([
      this.prisma.mediaSyncDevice.count({ where: { status: 'active' } }),
      this.androidReleases.current(),
    ]);
    if (activeDevices === 0 || !current) return decideAndroidReleases({ activeDevices, current, devicesBehind: 0 });

    // A device that has not reported a package name is counted when its
    // versionCode is lower; one running a different package (a debug build) is
    // not, since the current release cannot update it.
    const devicesBehind = await this.prisma.mediaSyncDevice.count({
      where: {
        status: 'active',
        appVersionCode: { lt: current.versionCode },
        OR: [{ packageName: current.packageName }, { packageName: null }],
      },
    });
    return decideAndroidReleases({ activeDevices, current, devicesBehind });
  }
}
