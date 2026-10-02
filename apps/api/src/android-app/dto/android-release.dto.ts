import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Android APK release responses (issue #504, epic #498)
// =============================================================================
//
// `sizeBytes` is a STRING: the column is a Postgres BIGINT (Prisma `BigInt`),
// which `JSON.stringify` cannot serialize. Consumers parse it with `Number()`
// (an APK is at most 150 MiB, well inside the safe-integer range).
// =============================================================================

/** What any signed-in user may see about a release. */
export const publicReleaseSchema = z.object({
  id: z.uuid(),
  packageName: z.string(),
  versionName: z.string(),
  versionCode: z.number().int(),
  /** Lowercase hex SHA-256 of the APK file. */
  fileSha256: z.string(),
  /** Bytes, as a decimal string (BigInt column). */
  sizeBytes: z.string(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** The administrator's view: adds signing, current flag and uploader. */
export const adminReleaseSchema = publicReleaseSchema.extend({
  /** The signing certificate fingerprint, uppercase colon-separated. */
  signingSha256: z.string(),
  /** Whether this is the release users are offered (at most one is). */
  isCurrent: z.boolean(),
  /** Null when the uploader's account was deleted. */
  uploadedBy: z
    .object({ id: z.uuid(), email: z.string(), displayName: z.string().nullable() })
    .nullable(),
});

export const downloadLinkSchema = z.object({
  /** Same-origin path: `/api/android-app/download/<token>`. Navigate to it. */
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export class PublicReleaseDto extends createZodDto(publicReleaseSchema) {}
export class AdminReleaseDto extends createZodDto(adminReleaseSchema) {}
export class DownloadLinkDto extends createZodDto(downloadLinkSchema) {}

export type PublicRelease = z.infer<typeof publicReleaseSchema>;
export type AdminRelease = z.infer<typeof adminReleaseSchema>;
export type DownloadLink = z.infer<typeof downloadLinkSchema>;
