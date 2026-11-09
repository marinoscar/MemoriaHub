import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { StorageProviderResolver } from '../../platform/storage/storage-provider.resolver';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass } from '../../doctor/checks/outcome';

// Ported from `DoctorService.checkAndroidUploadPath` (key `android.uploadPath`).
// READ-ONLY: resolves the active storage provider's capabilities; no object is
// read or written.
//
// The ACTIVE storage provider can take a phone's multipart upload: presigned
// part URLs (S3/R2), or the API part route (`PUT /api/storage/objects/:id/upload/parts/:n`,
// #506) for local disk. Since RETRO-D5 (#586) the APK upload is the android-app
// slice's, so this check resolves the active driver itself (the same rule the
// app's release upload applied: built, and a bucket unless it is `local`). Not
// skipped without devices: it
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
      'Configure a storage provider in Admin Settings → Storage.',
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

@Injectable()
export class AndroidUploadPathDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('android', 'upload-path');
  readonly category = 'android';
  readonly label = 'Phone upload path';
  readonly settingsPath = '/admin/settings/storage';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly storage: StorageProviderResolver,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    let target: Awaited<ReturnType<StorageProviderResolver['getActiveProvider']>>;
    try {
      target = await this.storage.getActiveProvider();
    } catch {
      return decideAndroidUploadPath({ providerId: null, missingProvider: 'unknown' });
    }
    if (target.id !== 'local' && !target.provider.getBucket()) {
      return decideAndroidUploadPath({ providerId: null, missingProvider: target.id });
    }
    return decideAndroidUploadPath({
      providerId: target.id,
      // The platform's provider contract (RETRO-D1): `partUploadMode: 'proxied'`
      // means the API part route, which needs `uploadPart`.
      supportsPresignedParts: target.provider.partUploadMode !== 'proxied',
      hasWritePart: typeof target.provider.uploadPart === 'function',
    });
  }
}
