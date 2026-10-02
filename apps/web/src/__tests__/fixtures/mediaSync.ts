/** Media Sync / Android release fixtures (issue #515). Shapes mirror the #504/#505 DTOs. */
import type { MediaSyncDevice, MediaSyncRun } from '../../services/mediaSync';
import type { PublicRelease } from '../../services/androidApp';
import type { Circle } from '../../types/circles';

export const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_CIRCLE_ID = '22222222-2222-4222-8222-222222222222';
export const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

export function makeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: CIRCLE_ID,
    name: 'Family',
    description: null,
    ownerId: 'test-user-id',
    isPersonal: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    memberRole: 'circle_admin',
    ...overrides,
  };
}

export function makeDevice(overrides: Partial<MediaSyncDevice> = {}): MediaSyncDevice {
  return {
    id: DEVICE_ID,
    installationId: '44444444-4444-4444-8444-444444444444',
    name: 'Pixel 9',
    manufacturer: 'Google',
    model: 'Pixel 9',
    androidVersion: '15',
    sdkInt: 35,
    appVersion: '2.0.0',
    appVersionCode: 100,
    packageName: 'memoriahub.marin.cr',
    timezone: 'America/Costa_Rica',
    latestVersionCode: 100,
    updateAvailable: false,
    status: 'active',
    config: {
      targetCircleId: CIRCLE_ID,
      folders: [{ bucketId: 'b-camera', name: 'Camera' }],
      includePhotos: true,
      includeVideos: true,
      network: 'wifi',
      requireCharging: false,
      paused: false,
      uploadExisting: 'all',
      retryFailedGeneration: 0,
      syncNowGeneration: 0,
    },
    configVersion: 3,
    appliedConfigVersion: 3,
    configPending: false,
    inventory: [
      { bucketId: 'b-camera', name: 'Camera', relativePath: 'DCIM/Camera/', photoCount: 120, videoCount: 4, bytes: 400_000_000 },
      { bucketId: 'b-whatsapp', name: 'WhatsApp Images', relativePath: 'WhatsApp/Media/', photoCount: 300, videoCount: 0, bytes: 90_000_000 },
      { bucketId: 'b-screens', name: 'Screenshots', relativePath: 'Pictures/Screenshots/', photoCount: 40, videoCount: 0, bytes: 10_000_000 },
    ],
    stats: {
      eligible: 124,
      uploaded: 90,
      deduplicated: 10,
      pending: 15,
      uploading: 1,
      failed: 6,
      blocked: 2,
      bytesPending: 52_428_800,
      bytesUploaded: 300_000_000,
    },
    permission: 'full',
    networkState: 'wifi',
    batteryOptimized: false,
    lastSeenAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastSyncStatus: 'ok',
    lastError: null,
    tokenExpiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeRun(overrides: Partial<MediaSyncRun> = {}): MediaSyncRun {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    deviceId: DEVICE_ID,
    trigger: 'periodic',
    status: 'partial',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:05:00.000Z',
    filesUploaded: 12,
    filesFailed: 2,
    filesDeduplicated: 3,
    bytesUploaded: '1048576',
    errorCode: null,
    details: {
      failedSample: [
        { name: 'IMG_0001.HEIC', relativePath: 'DCIM/Camera/', sizeBytes: 2_000_000, attempts: 3, lastError: 'HTTP 500' },
      ],
    },
    createdAt: '2026-10-01T10:05:00.000Z',
    ...overrides,
  };
}

export function makeRelease(overrides: Partial<PublicRelease> = {}): PublicRelease {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    packageName: 'memoriahub.marin.cr',
    versionName: '2.1.0',
    versionCode: 110,
    fileSha256: 'a'.repeat(64),
    sizeBytes: '15728640',
    notes: 'Faster uploads.',
    createdAt: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}
