import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { AndroidReleaseService } from '../../../android-app/releases/android-release.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass } from '../outcome';

// Ported from `DoctorService.checkAndroidUploadPath` (key `android.uploadPath`).
// READ-ONLY: resolves the active storage provider's capabilities; no object is
// read or written.
//
// The ACTIVE storage provider can take a phone's multipart upload: presigned
// part URLs (S3/R2), or the API part route (`PUT /api/storage/objects/:id/upload/parts/:n`,
// #506) for local disk. Reuses the APK upload's own "is storage configured"
// resolution so the two can never disagree. Not skipped without devices: it
// answers whether a phone COULD upload before anyone pairs one.
// Domain check: stays an app check (Media Sync is MemoriaHub's domain).

export interface UploadPathFacts {
  /** The provider id, or null when the active provider is not configured. */
  providerId: string | null;
  /** The provider key carried in the refusal, when not configured. */
  missingProvider?: string;
  supportsPresignedParts?: boolean;
  hasWritePart?: boolean;
}

export function decideAndroidUploadPath(f: UploadPathFacts): DoctorCheckOutcome {
  if (f.providerId === null) {
    return fail(
      `Phones cannot upload: the active storage provider "${f.missingProvider ?? 'unknown'}" is not configured.`,
      'Configure a storage provider in Admin Settings → Storage Providers.',
    );
  }
  if (f.supportsPresignedParts !== false) {
    return pass(`Active provider "${f.providerId}": phones upload parts to presigned URLs.`, { provider: f.providerId });
  }
  if (f.hasWritePart) {
    return pass(
      `Active provider "${f.providerId}": phones upload parts through the API part route (bearer auth).`,
      { provider: f.providerId },
    );
  }
  return fail(
    `Active provider "${f.providerId}" supports neither presigned part URLs nor API part uploads, so phones cannot upload.`,
    'Switch the active provider in Admin Settings → Storage Providers.',
    { provider: f.providerId },
  );
}

/** The provider key carried in a `STORAGE_NOT_CONFIGURED` refusal's details, else 'unknown'. */
export function providerFromError(err: unknown): string {
  const response =
    err && typeof err === 'object' && 'getResponse' in err && typeof err.getResponse === 'function'
      ? (err.getResponse() as unknown)
      : null;
  const details = response && typeof response === 'object' ? (response as Record<string, unknown>)['details'] : null;
  const provider = details && typeof details === 'object' ? (details as Record<string, unknown>)['provider'] : null;
  return typeof provider === 'string' && provider.length > 0 ? provider : 'unknown';
}

@Injectable()
export class AndroidUploadPathDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('android', 'upload-path');
  readonly category = 'android';
  readonly label = 'Phone upload path';
  readonly settingsPath = '/admin/settings/storage/providers';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly androidReleases: AndroidReleaseService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    let target: Awaited<ReturnType<AndroidReleaseService['resolveUploadTarget']>>;
    try {
      target = await this.androidReleases.resolveUploadTarget();
    } catch (err) {
      return decideAndroidUploadPath({ providerId: null, missingProvider: providerFromError(err) });
    }
    return decideAndroidUploadPath({
      providerId: target.id,
      supportsPresignedParts: target.provider.supportsPresignedParts,
      hasWritePart: typeof target.provider.writePart === 'function',
    });
  }
}
