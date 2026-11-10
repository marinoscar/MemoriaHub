import { z } from 'zod';
import { isSupportedTimeZone } from '../primitives/index.js';
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
} from './constants.js';



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

/**
 * Wire schema `folderSchema`.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
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
/**
 * Wire type `MediaSyncConfig`.
 *
 * @stability experimental
 */
export type MediaSyncConfig = z.infer<typeof mediaSyncConfigSchema>;

// -----------------------------------------------------------------------------
// Inventory and stats (reported by the phone)
// -----------------------------------------------------------------------------

/**
 * Wire schema `inventoryFolderSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `InventoryFolder`.
 *
 * @stability experimental
 */
export type InventoryFolder = z.infer<typeof inventoryFolderSchema>;

/**
 * Wire schema `inventorySchema`.
 *
 * @stability experimental
 */
export const inventorySchema = z
  .array(inventoryFolderSchema)
  .max(INVENTORY_MAX)
  .refine(uniqueFolders, { message: 'A bucketId may appear only once' })
  .meta({ description: `Every media folder on the phone (at most ${INVENTORY_MAX}).` });

/**
 * Wire schema `statsSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `MediaSyncStats`.
 *
 * @stability experimental
 */
export type MediaSyncStats = z.infer<typeof statsSchema>;

// -----------------------------------------------------------------------------
// POST /devices
// -----------------------------------------------------------------------------

/**
 * Wire schema `registerDeviceSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `RegisterDeviceInput`.
 *
 * @stability experimental
 */
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

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
/**
 * The library new media goes to, as an owner scope (RETRO-I6, #588): the caller's
 * personal library or one group. An ADDITIVE alias of `targetCircleId` on PATCH only:
 * the server resolves it to the same scope id and stores `targetCircleId`, which the
 * phone keeps reading and sending.
 *
 * @stability experimental
 */
export const targetOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('me') }).strict(),
  z.object({ kind: z.literal('group'), groupId: z.uuid() }).strict(),
]);
/**
 * Wire type `TargetOwner`.
 *
 * @stability experimental
 */
export type TargetOwner = z.infer<typeof targetOwnerSchema>;

/**
 * Wire schema `updateConfigSchema`.
 *
 * @stability experimental
 */
export const updateConfigSchema = z
  .object({
    targetCircleId: z.uuid().optional(),
    targetOwner: targetOwnerSchema.optional().meta({
      description:
        'The library new media goes to: `{ kind: "me" }` (your personal library) or `{ kind: "group", groupId }`. ' +
        'Resolved to `targetCircleId`, which the stored config keeps; refused with `details.reason` ' +
        '`TARGET_OWNER_FORBIDDEN`. Sending it with a different `targetCircleId` is 400.',
    }),
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
/**
 * Wire type `UpdateConfigInput`.
 *
 * @stability experimental
 */
export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;

// -----------------------------------------------------------------------------
// POST /devices/:id/commands
// -----------------------------------------------------------------------------

/**
 * Wire schema `commandSchema`.
 *
 * @stability experimental
 */
export const commandSchema = z
  .object({
    action: z.enum(MEDIA_SYNC_COMMANDS).meta({
      description:
        '`pause` / `resume` set `config.paused`; `retry_failed` / `sync_now` increment ' +
        '`retryFailedGeneration` / `syncNowGeneration`. Every command bumps `configVersion`.',
    }),
  })
  .strict();
/**
 * Wire type `CommandInput`.
 *
 * @stability experimental
 */
export type CommandInput = z.infer<typeof commandSchema>;

// -----------------------------------------------------------------------------
// POST /devices/:id/checkin
// -----------------------------------------------------------------------------

/**
 * Wire schema `failedSampleSchema`.
 *
 * @stability experimental
 */
export const failedSampleSchema = z
  .object({
    name: z.string().max(FOLDER_NAME_MAX),
    relativePath: relativePath.nullable().optional(),
    sizeBytes: count,
    attempts: count,
    lastError: z.string().max(FAILED_SAMPLE_ERROR_MAX).nullable().optional(),
  })
  .strict();

/**
 * Wire schema `perFolderSchema`.
 *
 * @stability experimental
 */
export const perFolderSchema = z
  .object({
    bucketId,
    uploaded: count.optional(),
    failed: count.optional(),
    deduplicated: count.optional(),
  })
  .strict();

/**
 * Wire schema `checkinRunSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `CheckinRunInput`.
 *
 * @stability experimental
 */
export type CheckinRunInput = z.infer<typeof checkinRunSchema>;

/**
 * Wire schema `checkinSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `CheckinInput`.
 *
 * @stability experimental
 */
export type CheckinInput = z.infer<typeof checkinSchema>;

// -----------------------------------------------------------------------------
// Diagnostics, queries
// -----------------------------------------------------------------------------

/**
 * Wire schema `uploadDiagnosticsSchema`.
 *
 * @stability experimental
 */
export const uploadDiagnosticsSchema = z
  .object({
    summary: z.string().trim().max(DIAGNOSTIC_SUMMARY_MAX).optional(),
    report: jsonObject.refine(serializedAtMost(DIAGNOSTIC_REPORT_MAX_BYTES), {
      message: `At most ${DIAGNOSTIC_REPORT_MAX_BYTES} bytes serialized`,
    }),
  })
  .strict();
/**
 * Wire type `UploadDiagnosticsInput`.
 *
 * @stability experimental
 */
export type UploadDiagnosticsInput = z.infer<typeof uploadDiagnosticsSchema>;

/**
 * Wire schema `mediaSyncListRunsQuerySchema`.
 *
 * @stability experimental
 */
export const mediaSyncListRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT_MAX).default(RUNS_LIMIT_DEFAULT),
});

/**
 * Wire schema `listReportsQuerySchema`.
 *
 * @stability experimental
 */
export const listReportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(REPORTS_LIMIT_MAX).default(REPORTS_LIMIT_DEFAULT),
});

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * Wire schema `deviceViewSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `DeviceView`.
 *
 * @stability experimental
 */
export type DeviceView = z.infer<typeof deviceViewSchema>;

/**
 * Wire schema `configResultSchema`.
 *
 * @stability experimental
 */
export const configResultSchema = z.object({
  config: mediaSyncConfigSchema,
  configVersion: z.number().int(),
});
/**
 * Wire type `ConfigResult`.
 *
 * @stability experimental
 */
export type ConfigResult = z.infer<typeof configResultSchema>;

/**
 * Wire schema `checkinResultSchema`.
 *
 * @stability experimental
 */
export const checkinResultSchema = z.object({
  config: mediaSyncConfigSchema,
  configVersion: z.number().int(),
  serverTime: z.iso.datetime(),
});
/**
 * Wire type `CheckinResult`.
 *
 * @stability experimental
 */
export type CheckinResult = z.infer<typeof checkinResultSchema>;

/**
 * Wire schema `runViewSchema`.
 *
 * @stability experimental
 */
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
/**
 * Wire type `RunView`.
 *
 * @stability experimental
 */
export type RunView = z.infer<typeof runViewSchema>;

/**
 * Wire schema `reportSummaryViewSchema`.
 *
 * @stability experimental
 */
export const reportSummaryViewSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
/**
 * Wire type `ReportSummaryView`.
 *
 * @stability experimental
 */
export type ReportSummaryView = z.infer<typeof reportSummaryViewSchema>;

/**
 * Wire schema `reportViewSchema`.
 *
 * @stability experimental
 */
export const reportViewSchema = reportSummaryViewSchema.extend({ report: jsonObject });
/**
 * Wire type `ReportView`.
 *
 * @stability experimental
 */
export type ReportView = z.infer<typeof reportViewSchema>;

/**
 * Wire schema `reportCreatedViewSchema`.
 *
 * @stability experimental
 */
export const reportCreatedViewSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() });
/**
 * Wire type `ReportCreatedView`.
 *
 * @stability experimental
 */
export type ReportCreatedView = z.infer<typeof reportCreatedViewSchema>;












/**
 * The parsed value of {@link mediaSyncListRunsQuerySchema}.
 *
 * @stability experimental
 */
export type MediaSyncListRunsQuery = z.infer<typeof mediaSyncListRunsQuerySchema>;

/**
 * The parsed value of {@link listReportsQuerySchema}.
 *
 * @stability experimental
 */
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

/**
 * One failed file of a check-in's `failedSample`.
 *
 * @stability experimental
 */
export type MediaSyncFailedFile = z.infer<typeof failedSampleSchema>;

/**
 * One per-folder count of a check-in run.
 *
 * @stability experimental
 */
export type MediaSyncPerFolder = z.infer<typeof perFolderSchema>;
