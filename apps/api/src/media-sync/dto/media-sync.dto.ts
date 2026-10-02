import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isSupportedTimeZone } from '../../common/time/zone.util';
import {
  APP_VERSION_MAX,
  BUCKET_ID_MAX,
  CONFIG_FOLDERS_MAX,
  DEVICE_STRING_MAX,
  DIAGNOSTIC_REPORT_MAX_BYTES,
  DIAGNOSTIC_SUMMARY_MAX,
  FAILED_SAMPLE_ERROR_MAX,
  FAILED_SAMPLE_MAX,
  FOLDER_NAME_MAX,
  INVENTORY_MAX,
  MEDIA_SYNC_COMMANDS,
  MEDIA_SYNC_DEVICE_STATUSES,
  MEDIA_SYNC_NETWORK_POLICIES,
  MEDIA_SYNC_NETWORK_STATES,
  MEDIA_SYNC_PERMISSIONS,
  MEDIA_SYNC_RUN_STATUSES,
  MEDIA_SYNC_TRIGGERS,
  MEDIA_SYNC_UPLOAD_EXISTING,
  PACKAGE_NAME_PATTERN,
  PER_FOLDER_MAX,
  RELATIVE_PATH_MAX,
  REPORTS_LIMIT_DEFAULT,
  REPORTS_LIMIT_MAX,
  RUN_ERROR_CODE_MAX,
  RUNS_LIMIT_DEFAULT,
  RUNS_LIMIT_MAX,
  SIGNING_SHA256_PATTERN,
} from '../media-sync.constants';

// =============================================================================
// /api/media-sync — schemas (epic #498, issue #505)
// =============================================================================
//
// Everything a phone (or the web) sends is validated here, strictly: an
// unknown key is a 400, never silently dropped, so a phone built against a
// newer contract fails loudly instead of believing the server stored a field
// it ignored. The contract is docs/specs/android-media-sync.md (#501).
// =============================================================================

const deviceString = z.string().trim().max(DEVICE_STRING_MAX, `At most ${DEVICE_STRING_MAX} characters`);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bucketId = z.string().trim().min(1).max(BUCKET_ID_MAX);
const relativePath = z.string().max(RELATIVE_PATH_MAX);
const appVersion = z.string().trim().max(APP_VERSION_MAX, `At most ${APP_VERSION_MAX} characters`);
const appVersionCode = z.number().int().min(1).max(2_100_000_000);

function serializedAtMost(maxBytes: number) {
  return (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
}

const jsonObject = z.record(z.string(), z.unknown());

/**
 * Accepts a SHA-256 certificate fingerprint as 64 hex digits, with or without
 * colons, in any case, and normalises it to the `AA:BB:…` upper-case form
 * Digital Asset Links and the trusted-signer list use.
 */
const signingSha256 = z
  .string()
  .trim()
  .transform((value) => {
    const hex = value.replace(/:/g, '').toUpperCase();
    return /^[0-9A-F]{64}$/.test(hex) ? (hex.match(/.{2}/g) as string[]).join(':') : value;
  })
  .pipe(z.string().regex(SIGNING_SHA256_PATTERN, 'Must be a SHA-256 fingerprint (32 hex bytes)'))
  .meta({ description: 'The APK signing certificate SHA-256; stored as `AA:BB:…` (32 upper-case bytes).' });

const timeZone = z
  .string()
  .trim()
  .max(DEVICE_STRING_MAX)
  .refine(isSupportedTimeZone, { message: 'Must be an IANA time zone' })
  .meta({ description: 'An IANA time zone, e.g. `America/Costa_Rica`.' });

// -----------------------------------------------------------------------------
// Desired config (MediaSyncDevice.config)
// -----------------------------------------------------------------------------

export const folderSchema = z
  .object({
    bucketId: bucketId.meta({ description: "MediaStore `BUCKET_ID`, as reported in the device's inventory." }),
    name: z.string().trim().min(1).max(FOLDER_NAME_MAX),
  })
  .strict();

const uniqueFolders = (folders: Array<{ bucketId: string }>) =>
  new Set(folders.map((folder) => folder.bucketId)).size === folders.length;

const foldersSchema = z
  .array(folderSchema)
  .max(CONFIG_FOLDERS_MAX)
  .refine(uniqueFolders, { message: 'A folder may be listed only once' })
  .meta({ description: `At most ${CONFIG_FOLDERS_MAX}; an empty list means nothing syncs.` });

/**
 * The desired configuration the server holds for one phone. The phone pulls
 * it on every check-in; the web and the phone's native screens edit it.
 * `retryFailedGeneration` / `syncNowGeneration` only ever increase, through
 * `POST /devices/:id/commands`; the phone acts when it sees a larger value
 * than it last applied.
 */
export const mediaSyncConfigSchema = z
  .object({
    targetCircleId: z.uuid().meta({ description: 'The circle new media is uploaded into.' }),
    folders: foldersSchema,
    includePhotos: z.boolean(),
    includeVideos: z.boolean(),
    network: z
      .enum(MEDIA_SYNC_NETWORK_POLICIES)
      .meta({ description: '`wifi`: unmetered networks only; `any`: Wi-Fi and mobile data.' }),
    requireCharging: z.boolean(),
    paused: z.boolean(),
    uploadExisting: z
      .enum(MEDIA_SYNC_UPLOAD_EXISTING)
      .meta({ description: '`all`: the whole library of the chosen folders; `from_pairing`: only media added after pairing.' }),
    retryFailedGeneration: count,
    syncNowGeneration: count,
  })
  .strict();
export type MediaSyncConfig = z.infer<typeof mediaSyncConfigSchema>;
export class MediaSyncConfigDto extends createZodDto(mediaSyncConfigSchema) {}

// -----------------------------------------------------------------------------
// Inventory and stats (reported by the phone)
// -----------------------------------------------------------------------------

export const inventoryFolderSchema = z
  .object({
    bucketId,
    name: z.string().trim().min(1).max(FOLDER_NAME_MAX),
    relativePath: relativePath.nullable().optional(),
    photoCount: count,
    videoCount: count,
    bytes: count,
  })
  .strict();
export type InventoryFolder = z.infer<typeof inventoryFolderSchema>;

export const inventorySchema = z
  .array(inventoryFolderSchema)
  .max(INVENTORY_MAX)
  .refine(uniqueFolders, { message: 'A bucketId may appear only once' })
  .meta({ description: `Every media folder on the phone (at most ${INVENTORY_MAX}).` });

export const statsSchema = z
  .object({
    eligible: count,
    uploaded: count,
    deduplicated: count,
    pending: count,
    uploading: count,
    failed: count,
    blocked: count,
    bytesPending: count,
    bytesUploaded: count,
  })
  .strict()
  .meta({ description: "Counts from the phone's file ledger, which is authoritative per file." });
export type MediaSyncStats = z.infer<typeof statsSchema>;

// -----------------------------------------------------------------------------
// POST /devices
// -----------------------------------------------------------------------------

export const registerDeviceSchema = z
  .object({
    installationId: z.uuid().meta({ description: 'Generated once per app install.' }),
    name: deviceString.min(1, 'Name is required'),
    manufacturer: deviceString.optional(),
    model: deviceString.optional(),
    androidVersion: deviceString.optional(),
    sdkInt: z.number().int().min(0).max(10_000).optional(),
    appVersion: appVersion.optional(),
    appVersionCode: appVersionCode.optional(),
    packageName: z
      .string()
      .trim()
      .max(DEVICE_STRING_MAX)
      .regex(PACKAGE_NAME_PATTERN, 'Must be an Android application id')
      .optional()
      .meta({ description: 'The installed application id, e.g. `memoriahub.marin.cr`. Never re-cased.' }),
    signingSha256: signingSha256.optional(),
    timezone: timeZone.optional(),
  })
  .strict();
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}

// -----------------------------------------------------------------------------
// PATCH /devices/:id/config
// -----------------------------------------------------------------------------

/**
 * A partial desired-config update. `paused` and the generations are absent on
 * purpose: they move only through `/commands`, so they are rejected here as
 * unknown keys. `inventory` lets the phone (PAT only) report a freshly created
 * folder in the same request that selects it. Folder `name`s are overwritten
 * from the inventory entry by the server.
 */
export const updateConfigSchema = z
  .object({
    targetCircleId: z.uuid().optional(),
    folders: foldersSchema.optional(),
    includePhotos: z.boolean().optional(),
    includeVideos: z.boolean().optional(),
    network: z.enum(MEDIA_SYNC_NETWORK_POLICIES).optional(),
    requireCharging: z.boolean().optional(),
    uploadExisting: z.enum(MEDIA_SYNC_UPLOAD_EXISTING).optional(),
    inventory: inventorySchema.optional().meta({
      description:
        "The phone's current folder inventory (personal access token only, else 400 `INVENTORY_NOT_ALLOWED`); " +
        'stored, then used to validate `folders`.',
    }),
  })
  .strict();
export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
export class UpdateConfigDto extends createZodDto(updateConfigSchema) {}

// -----------------------------------------------------------------------------
// POST /devices/:id/commands
// -----------------------------------------------------------------------------

export const commandSchema = z
  .object({
    action: z.enum(MEDIA_SYNC_COMMANDS).meta({
      description:
        '`pause` / `resume` set `config.paused`; `retry_failed` / `sync_now` increment ' +
        '`retryFailedGeneration` / `syncNowGeneration`. Every command bumps `configVersion`.',
    }),
  })
  .strict();
export type CommandInput = z.infer<typeof commandSchema>;
export class CommandDto extends createZodDto(commandSchema) {}

// -----------------------------------------------------------------------------
// POST /devices/:id/checkin
// -----------------------------------------------------------------------------

export const failedSampleSchema = z
  .object({
    name: z.string().max(FOLDER_NAME_MAX),
    relativePath: relativePath.nullable().optional(),
    sizeBytes: count,
    attempts: count,
    lastError: z.string().max(FAILED_SAMPLE_ERROR_MAX).nullable().optional(),
  })
  .strict();

export const perFolderSchema = z
  .object({
    bucketId,
    uploaded: count.optional(),
    failed: count.optional(),
    deduplicated: count.optional(),
  })
  .strict();

export const checkinRunSchema = z
  .object({
    trigger: z.enum(MEDIA_SYNC_TRIGGERS),
    status: z.enum(MEDIA_SYNC_RUN_STATUSES),
    startedAt: instant,
    finishedAt: instant,
    filesUploaded: count,
    bytesUploaded: count,
    filesFailed: count,
    filesDeduplicated: count,
    errorCode: z.string().trim().min(1).max(RUN_ERROR_CODE_MAX).optional(),
    failedSample: z.array(failedSampleSchema).max(FAILED_SAMPLE_MAX).optional().meta({
      description: `Up to ${FAILED_SAMPLE_MAX} files that failed, for the web's Files view.`,
    }),
    perFolder: z.array(perFolderSchema).max(PER_FOLDER_MAX).optional().meta({
      description: `Optional per-folder counts (at most ${PER_FOLDER_MAX}); stored in the run's \`details\`.`,
    }),
  })
  .strict()
  .refine((run) => Date.parse(run.finishedAt) >= Date.parse(run.startedAt), {
    message: 'finishedAt must not be before startedAt',
    path: ['finishedAt'],
  });
export type CheckinRunInput = z.infer<typeof checkinRunSchema>;

export const checkinSchema = z
  .object({
    appliedConfigVersion: z.number().int().min(0).max(2_100_000_000).meta({
      description: 'The `configVersion` the phone has applied.',
    }),
    inventory: inventorySchema.optional(),
    stats: statsSchema,
    permission: z.enum(MEDIA_SYNC_PERMISSIONS),
    networkState: z.enum(MEDIA_SYNC_NETWORK_STATES),
    batteryOptimized: z.boolean(),
    appVersion: appVersion.optional(),
    appVersionCode: appVersionCode.optional(),
    run: checkinRunSchema.optional().meta({ description: 'The sync pass that just finished, if any.' }),
  })
  .strict();
export type CheckinInput = z.infer<typeof checkinSchema>;
export class CheckinDto extends createZodDto(checkinSchema) {}

// -----------------------------------------------------------------------------
// Diagnostics, queries
// -----------------------------------------------------------------------------

export const uploadDiagnosticsSchema = z
  .object({
    summary: z.string().trim().max(DIAGNOSTIC_SUMMARY_MAX).optional(),
    report: jsonObject.refine(serializedAtMost(DIAGNOSTIC_REPORT_MAX_BYTES), {
      message: `At most ${DIAGNOSTIC_REPORT_MAX_BYTES} bytes serialized`,
    }),
  })
  .strict();
export type UploadDiagnosticsInput = z.infer<typeof uploadDiagnosticsSchema>;
export class UploadDiagnosticsDto extends createZodDto(uploadDiagnosticsSchema) {}

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT_MAX).default(RUNS_LIMIT_DEFAULT),
});
export class ListRunsQueryDto extends createZodDto(listRunsQuerySchema) {}

export const listReportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(REPORTS_LIMIT_MAX).default(REPORTS_LIMIT_DEFAULT),
});
export class ListReportsQueryDto extends createZodDto(listReportsQuerySchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const deviceViewSchema = z.object({
  id: z.uuid(),
  installationId: z.uuid(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  androidVersion: z.string().nullable(),
  sdkInt: z.number().int().nullable(),
  appVersion: z.string().nullable(),
  appVersionCode: z.number().int().nullable(),
  packageName: z.string().nullable(),
  timezone: z.string().nullable(),
  latestVersionCode: z.number().int().nullable().meta({
    description: "The current server release's versionCode for this device's package; null when there is none.",
  }),
  updateAvailable: z.boolean().meta({
    description: 'True when the current server release is newer than the installed app (same package).',
  }),
  status: z.enum(MEDIA_SYNC_DEVICE_STATUSES),
  config: mediaSyncConfigSchema,
  configVersion: z.number().int(),
  appliedConfigVersion: z.number().int(),
  configPending: z.boolean().meta({ description: '`appliedConfigVersion < configVersion`: the phone has not applied the latest config yet.' }),
  inventory: z.array(inventoryFolderSchema).nullable(),
  stats: statsSchema.nullable(),
  permission: z.enum(MEDIA_SYNC_PERMISSIONS).nullable(),
  networkState: z.enum(MEDIA_SYNC_NETWORK_STATES).nullable(),
  batteryOptimized: z.boolean().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  lastSyncAt: z.iso.datetime().nullable(),
  lastSyncStatus: z.enum(MEDIA_SYNC_RUN_STATUSES).nullable(),
  lastError: z.string().nullable(),
  tokenExpiresAt: z.iso.datetime().nullable().meta({ description: 'Expiry of the linked access token; null when none or revoked.' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DeviceView = z.infer<typeof deviceViewSchema>;
export class DeviceViewDto extends createZodDto(deviceViewSchema) {}

export const configResultSchema = z.object({
  config: mediaSyncConfigSchema,
  configVersion: z.number().int(),
});
export type ConfigResult = z.infer<typeof configResultSchema>;
export class ConfigResultDto extends createZodDto(configResultSchema) {}

export const checkinResultSchema = z.object({
  config: mediaSyncConfigSchema,
  configVersion: z.number().int(),
  serverTime: z.iso.datetime(),
});
export type CheckinResult = z.infer<typeof checkinResultSchema>;
export class CheckinResultDto extends createZodDto(checkinResultSchema) {}

export const runViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  trigger: z.enum(MEDIA_SYNC_TRIGGERS),
  status: z.enum(MEDIA_SYNC_RUN_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  filesUploaded: z.number().int(),
  filesFailed: z.number().int(),
  filesDeduplicated: z.number().int(),
  bytesUploaded: z.string().meta({ description: 'A decimal string (64-bit counter).' }),
  errorCode: z.string().nullable(),
  details: jsonObject.nullable().meta({ description: '`{ failedSample?, perFolder? }` as reported.' }),
  createdAt: z.iso.datetime(),
});
export type RunView = z.infer<typeof runViewSchema>;
export class RunViewDto extends createZodDto(runViewSchema) {}

export const reportSummaryViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportSummaryView = z.infer<typeof reportSummaryViewSchema>;
export class ReportSummaryViewDto extends createZodDto(reportSummaryViewSchema) {}

export const reportViewSchema = reportSummaryViewSchema.extend({ report: jsonObject });
export type ReportView = z.infer<typeof reportViewSchema>;
export class ReportViewDto extends createZodDto(reportViewSchema) {}

export const reportCreatedViewSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });
export type ReportCreatedView = z.infer<typeof reportCreatedViewSchema>;
export class ReportCreatedViewDto extends createZodDto(reportCreatedViewSchema) {}
