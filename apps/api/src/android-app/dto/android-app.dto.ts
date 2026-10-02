import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ASSET_LINKS_RELATION, MAX_TRUSTED_ANDROID_APPS, trustedAndroidAppsSchema } from '../android-app.schema';

// =============================================================================
// `PUT /api/admin/android-app` body and the admin response (issue #503)
// =============================================================================

export const updateAndroidAppSchema = z
  .object({
    /**
     * The complete list of trusted apps (replaces the stored one). At most
     * ten. `sha256` is accepted in either case, colon-separated or as 64 hex
     * digits, and stored uppercase colon-separated; repeated
     * (packageName, sha256) pairs are dropped. An empty list publishes `[]`.
     */
    trustedApps: trustedAndroidAppsSchema.describe(
      `Every trusted (packageName, sha256) pair, at most ${MAX_TRUSTED_ANDROID_APPS}.`,
    ),
  })
  .strict();

/**
 * Documents the body in OpenAPI only. The controller validates through
 * `TrustedAppsValidationPipe` instead of the global `ZodValidationPipe`, so a
 * malformed body gets a 400 carrying `details.reason` (see that pipe).
 */
export class UpdateAndroidAppDto extends createZodDto(updateAndroidAppSchema) {}
export type UpdateAndroidAppInput = z.output<typeof updateAndroidAppSchema>;

const trustedAppResponseSchema = z.object({
  /** Exactly as stored; never re-cased. */
  packageName: z.string(),
  /** Uppercase, colon-separated. */
  sha256: z.string(),
});

const reportedAppSchema = z.object({
  packageName: z.string(),
  /** The signing certificate fingerprint the app reported, uppercase colon-separated. */
  sha256: z.string(),
  /** ACTIVE Media Sync devices reporting this exact (packageName, sha256). */
  deviceCount: z.number().int(),
  /** The most recent time one of those devices was seen; null when none has been. */
  lastSeenAt: z.string().nullable(),
  /** Whether this pair is in `trustedApps` (so the app opens without a URL bar). */
  trusted: z.boolean(),
});

const assetLinkStatementSchema = z.object({
  relation: z.array(z.string()).describe(`Always \`["${ASSET_LINKS_RELATION}"]\`.`),
  target: z.object({
    namespace: z.literal('android_app'),
    package_name: z.string(),
    sha256_cert_fingerprints: z.array(z.string()),
  }),
});

export const androidAppResponseSchema = z.object({
  /** The stored list, as `/.well-known/assetlinks.json` publishes it. */
  trustedApps: z.array(trustedAppResponseSchema),
  /**
   * Distinct (packageName, sha256) pairs reported by ACTIVE Media Sync
   * devices (`media_sync_devices`), most devices first. A pair not in
   * `trustedApps` is an app Chrome will open with a URL bar.
   */
  reportedApps: z.array(reportedAppSchema),
  /** Exactly the body `GET /.well-known/assetlinks.json` serves. */
  assetLinks: z.array(assetLinkStatementSchema),
});

export class AndroidAppResponseDto extends createZodDto(androidAppResponseSchema) {}
export type AndroidAppResponse = z.infer<typeof androidAppResponseSchema>;
export type ReportedAndroidApp = z.infer<typeof reportedAppSchema>;
