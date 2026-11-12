import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { DOCTOR_CHECK_TIMEOUT_MS, doctorCheckId, fail, pass, skip } from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_OBJECT_STORE,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubObjectStorePort,
} from '../../ports/index.js';

// Ported from `DoctorService.checkAndroidUploadPath` (key `android.uploadPath`).
// READ-ONLY: resolves the active store and reads its capabilities; no object is read or written.
//
// The ACTIVE store can take a phone's multipart upload: presigned part URLs (S3/R2), or the API part route
// (`PUT /api/storage/objects/:id/upload/parts/:n`, #506) for local disk. Not skipped without devices: it
// answers whether a phone COULD upload before anyone pairs one. A domain check: the media slice's (Media
// Sync is MemoriaHub's domain), registered through `MEMORIAHUB_DOCTOR` under the permanent id
// `memoriahub.android.upload-path`.

/** Where an administrator manages the storage provider. @stability experimental */
export const ANDROID_UPLOAD_PATH_SETTINGS_PATH = '/admin/settings/storage';

/** The facts the upload-path check decides on. @stability experimental */
export interface UploadPathFacts {
  /** The store id, or null when the active store is not configured. */
  providerId: string | null;
  /** The store key carried in the refusal, when not configured. */
  missingProvider?: string;
  supportsPresignedParts?: boolean;
  hasWritePart?: boolean;
}

/** The status ladder of the upload-path check. @stability experimental */
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

/**
 * The phone upload path check.
 *
 * @stability experimental
 */
@Injectable()
export class AndroidUploadPathDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('android', 'upload-path');
  readonly category = 'android';
  readonly label = 'Phone upload path';
  readonly settingsPath = ANDROID_UPLOAD_PATH_SETTINGS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_OBJECT_STORE) private readonly objectStore: MemoriahubObjectStorePort,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    let active: Awaited<ReturnType<MemoriahubObjectStorePort['active']>>;
    try {
      active = await this.objectStore.active();
    } catch {
      return decideAndroidUploadPath({ providerId: null, missingProvider: 'unknown' });
    }
    // The same rule the APK upload applies: a built driver, and a bucket unless it is `local`.
    if (active.id !== 'local' && !active.store.getBucket()) {
      return decideAndroidUploadPath({ providerId: null, missingProvider: active.id });
    }
    const capabilities = active.store.capabilities;
    if (!capabilities) return skip(`The object store "${active.id}" does not report its multipart upload capabilities.`);
    return decideAndroidUploadPath({
      providerId: active.id,
      supportsPresignedParts: capabilities.partUploadMode !== 'proxied',
      hasWritePart: capabilities.acceptsPartBytes,
    });
  }
}
