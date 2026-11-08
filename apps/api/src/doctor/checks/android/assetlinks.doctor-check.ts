import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { AndroidAppService } from '../../../android-app/android-app.service';
import { AndroidReleaseService } from '../../../android-app/releases/android-release.service';
import { normalizeSha256Fingerprint, trustedAppKey } from '../../../android-app/android-app.schema';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass, skip, warn } from '../outcome';
import { ANDROID_LIST_LIMIT_APPS, ANDROID_SETTINGS_HINT, ANDROID_SETTINGS_PATH } from './constants';

// Ported from `DoctorService.checkAndroidAssetLinks` (key `android.assetlinks`,
// epic #498, issue #507). READ-ONLY: trusted apps from AndroidAppService (its
// own `android_app` settings row), the current release from
// AndroidReleaseService and the reported signers through one grouped SELECT.
// Reports package names and SHA-256 signer fingerprints (public certificate
// digests, as published in assetlinks.json), never a key.
//
// Every (package, signer) an active device reports, and the current release's
// signer, must be vouched for by assetlinks.json; an untrusted pair opens the
// PWA shell with a URL bar.
// Retirement: replaced by the android-app slice's check (RETRO-D5).

export interface AssetLinksFacts {
  trustedKeys: Set<string>;
  reported: Array<{ packageName: string; sha256: string; deviceCount: number; trusted: boolean }>;
  current: { packageName: string; signingSha256: string; versionName: string; versionCode: number } | null;
}

export function decideAssetLinks(f: AssetLinksFacts): DoctorCheckOutcome {
  const releaseUntrusted =
    f.current !== null && !f.trustedKeys.has(trustedAppKey(f.current.packageName, f.current.signingSha256));

  if (f.reported.length === 0 && !releaseUntrusted) {
    return skip('No active Media Sync device has reported its app signer.');
  }

  const untrusted = f.reported.filter((app) => !app.trusted);
  const problems: string[] = [];
  if (untrusted.length > 0) {
    const listed = untrusted
      .slice(0, ANDROID_LIST_LIMIT_APPS)
      .map((app) => `${app.packageName} (${app.sha256}, ${app.deviceCount} device(s))`)
      .join('; ');
    const more = untrusted.length > ANDROID_LIST_LIMIT_APPS ? '; …' : '';
    problems.push(
      `${untrusted.length} reported app signer(s) are not trusted, so the app opens with a URL bar: ${listed}${more}`,
    );
  }
  if (releaseUntrusted && f.current) {
    problems.push(
      `the current release ${f.current.versionName} (${f.current.versionCode}) is signed by ` +
        `${f.current.packageName} (${normalizeSha256Fingerprint(f.current.signingSha256)}), which is not trusted`,
    );
  }

  if (problems.length > 0) {
    return warn(`${problems.join('. ')}.`, `Trust it in ${ANDROID_SETTINGS_HINT}.`, {
      untrustedSigners: untrusted.length,
      releaseUntrusted,
    });
  }
  return pass(`All ${f.reported.length} reported app signer(s) are trusted in assetlinks.json.`, {
    reportedSigners: f.reported.length,
  });
}

@Injectable()
export class AndroidAssetLinksDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('android', 'assetlinks');
  readonly category = 'android';
  readonly label = 'Digital Asset Links';
  readonly settingsPath = ANDROID_SETTINGS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly androidApp: AndroidAppService,
    private readonly androidReleases: AndroidReleaseService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const trusted = await this.androidApp.getTrustedApps();
      const [reported, current] = await Promise.all([
        this.androidApp.getReportedApps(trusted),
        this.androidReleases.current(),
      ]);
      return decideAssetLinks({
        trustedKeys: new Set(trusted.map((app) => trustedAppKey(app.packageName, app.sha256))),
        reported,
        current,
      });
    } catch (err) {
      return fail(
        `Could not read the trusted Android apps: ${errorMessage(err)}`,
        `Check the database connection, then open ${ANDROID_SETTINGS_HINT}.`,
      );
    }
  }
}
