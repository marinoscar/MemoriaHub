import { z } from 'zod';

import { androidPackageNameSchema, sha256FingerprintSchema } from '../android-app.schema';
import {
  ANDROID_RELEASE_REASONS,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_VERSION_CODE,
  MAX_VERSION_NAME_LENGTH,
  MIN_VERSION_CODE,
} from './android-release.constants';

// =============================================================================
// Upload metadata and the version rules (issue #504, epic #498)
// =============================================================================
//
// The upload is multipart, so every field arrives as a STRING: the schema
// coerces `versionCode`, `makeCurrent` and `force` itself rather than relying
// on the global pipe (which never sees a multipart body).
// =============================================================================

/** `0.1.0`, `1.2.3-beta+4`: what a file name can safely carry. */
export const VERSION_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

/**
 * A signing certificate SHA-256: `keytool`'s 32 colon-separated hex bytes, or
 * the same 64 hex digits without colons (the CLI sidecar's lowercase form);
 * either case. Normalised to the uppercase colon form the trusted-apps list
 * uses — the same schema `PUT /api/admin/android-app` validates with.
 */
export const signingSha256Schema = z.string().trim().pipe(sha256FingerprintSchema);

const booleanField = (fallback: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === true || value === 'true' || value === '1'));

export const releaseUploadFieldsSchema = z
  .object({
    packageName: androidPackageNameSchema,
    versionName: z
      .string()
      .trim()
      .min(1)
      .max(MAX_VERSION_NAME_LENGTH)
      .regex(VERSION_NAME_PATTERN, 'versionName may contain only letters, digits, ".", "_", "+" and "-"'),
    versionCode: z.coerce
      .number()
      .int('versionCode must be an integer')
      .min(MIN_VERSION_CODE)
      .max(MAX_VERSION_CODE),
    signingSha256: signingSha256Schema,
    notes: z
      .string()
      .trim()
      .max(MAX_RELEASE_NOTES_LENGTH)
      .optional()
      .transform((value) => (value ? value : null)),
    makeCurrent: booleanField(true),
    force: booleanField(false),
  })
  .strict();

export type ReleaseUploadFields = z.output<typeof releaseUploadFieldsSchema>;

/**
 * Making a release current must not move a package BACKWARDS by accident:
 * Android refuses to install a lower `versionCode` over a higher one, so a
 * phone that took the current release could never take this one. Refused
 * unless `force` (an explicit rollback). A current release of a DIFFERENT
 * package does not constrain it.
 *
 * Returns the refusal reason, or null when allowed. (The other version rule,
 * `RELEASE_VERSION_EXISTS`, is decided by the `(package_name, version_code)`
 * unique index.)
 */
export function versionRuleRefusal(
  current: { packageName: string; versionCode: number } | null,
  next: { packageName: string; versionCode: number },
  force: boolean,
): typeof ANDROID_RELEASE_REASONS.VERSION_NOT_NEWER | null {
  if (force || !current) return null;
  if (current.packageName !== next.packageName) return null;
  return current.versionCode >= next.versionCode ? ANDROID_RELEASE_REASONS.VERSION_NOT_NEWER : null;
}
