import { z } from 'zod';

// =============================================================================
// Android app trust and Digital Asset Links (issue #503, epic #498)
// =============================================================================
//
// The Android app is a Trusted Web Activity: Chrome only shows the site
// full-screen (no URL bar) when `/.well-known/assetlinks.json` on this origin
// names the app's package (`memoriahub.marin.cr`) AND the SHA-256 fingerprint
// of the certificate it was signed with. Both facts are deployment-specific
// (every fork signs with its own key, debug builds with a throwaway one), so
// they are RUNTIME configuration, never an environment variable: an
// administrator lists the trusted apps at `PUT /api/admin/android-app`, and
// making an uploaded APK release current trusts its key automatically (#504,
// through `AndroidAppService.ensureTrusted`).
//
// STORAGE. Its own `system_settings` row (`key = 'android_app'`, value
// `{ trustedApps: [...] }`) rather than a namespace of the `global` row — the
// same choice the `webPush` row made (notifications/push/push-config.schema.ts):
// the generic `GET /api/system-settings` never returns it, a save of an
// unrelated setting can never clobber it, it has its own version counter and
// audit trail, and it sidesteps the "hand-maintained copies" of the `global`
// document entirely.
//
// Ported from evopath's `apps/api/src/android-app/android-app.schema.ts` with
// one addition: a fingerprint may also be pasted as 64 bare hex digits (what
// `apksigner verify --print-certs` prints), normalised to the colon form.
// =============================================================================

/** `system_settings.key` of the row holding the trusted apps. */
export const ANDROID_APP_SETTINGS_KEY = 'android_app';

/** Audit action written on every save. */
export const ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION = 'android_app.trusted_apps.updated';

/** The most trusted apps a deployment may list. Debug + release + a spare or two. */
export const MAX_TRUSTED_ANDROID_APPS = 10;

/** The relation Chrome checks for a TWA. */
export const ASSET_LINKS_RELATION = 'delegate_permission/common.handle_all_urls';

/**
 * `details.reason` values of the 400 a malformed `PUT /api/admin/android-app`
 * body gets (docs/specs/android-media-sync.md §17.2). Uppercase, like every
 * other reason (§22 D22). `INVALID_TRUSTED_APPS` covers what the spec's three
 * do not name: a missing or non-array `trustedApps`, an unknown key, a
 * non-object entry.
 */
export const TRUSTED_APPS_ERROR_REASONS = {
  INVALID_FINGERPRINT: 'INVALID_FINGERPRINT',
  INVALID_PACKAGE_NAME: 'INVALID_PACKAGE_NAME',
  TOO_MANY_TRUSTED_APPS: 'TOO_MANY_TRUSTED_APPS',
  INVALID_TRUSTED_APPS: 'INVALID_TRUSTED_APPS',
} as const;

export type TrustedAppsErrorReason =
  (typeof TRUSTED_APPS_ERROR_REASONS)[keyof typeof TRUSTED_APPS_ERROR_REASONS];

/**
 * An Android application id: at least two dot-separated segments, each
 * starting with a letter (the rule `aapt` enforces). Case is SIGNIFICANT and
 * preserved: Android package names are case-sensitive, so `memoriahub.marin.cr`
 * and `MemoriaHub.marin.cr` are two different apps and are never re-cased.
 */
export const ANDROID_PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** A SHA-256 certificate fingerprint as `keytool` prints it: 32 colon-separated hex bytes, uppercase. */
export const SHA256_FINGERPRINT_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** The same fingerprint as 64 bare hex digits (any case), as `apksigner` prints it. */
const SHA256_BARE_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Normalises a SHA-256 certificate fingerprint to the canonical uppercase
 * colon-separated form. Accepts either case and either the colon form or 64
 * bare hex digits; surrounding whitespace is ignored. Anything else is
 * returned trimmed and uppercased but otherwise untouched, so a caller that
 * validates afterwards (the schema below) still rejects it.
 */
export function normalizeSha256Fingerprint(value: string): string {
  const trimmed = value.trim();
  if (SHA256_BARE_HEX_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase().match(/.{2}/g)!.join(':');
  }
  return trimmed.toUpperCase();
}

export const androidPackageNameSchema = z
  .string()
  .trim()
  .max(255)
  .regex(ANDROID_PACKAGE_NAME_PATTERN, 'packageName must be an Android application id such as com.example.app');

/**
 * Accepted in either case, as colon-separated bytes or 64 bare hex digits, and
 * NORMALISED to the uppercase colon form, so a fingerprint compares equal
 * however it was pasted and assetlinks.json always publishes one spelling.
 */
export const sha256FingerprintSchema = z
  .string()
  .transform(normalizeSha256Fingerprint)
  .pipe(
    z
      .string()
      .regex(
        SHA256_FINGERPRINT_PATTERN,
        'sha256 must be a SHA-256 certificate fingerprint: 32 colon-separated hex bytes (AA:BB:…) or 64 hex digits',
      ),
  );

export const trustedAndroidAppSchema = z.object({
  packageName: androidPackageNameSchema,
  sha256: sha256FingerprintSchema,
});

export type TrustedAndroidApp = z.output<typeof trustedAndroidAppSchema>;

/**
 * One pair's identity for comparisons. The package name compares
 * CASE-SENSITIVELY (it is never re-cased); the fingerprint is normalised, so
 * its case and colons do not matter.
 */
export function trustedAppKey(packageName: string, sha256: string): string {
  return `${packageName}\u0000${normalizeSha256Fingerprint(sha256)}`;
}

/** Drops repeated (packageName, sha256) pairs, keeping the first occurrence and the order. */
export function dedupeTrustedApps(apps: readonly TrustedAndroidApp[]): TrustedAndroidApp[] {
  const seen = new Set<string>();
  const result: TrustedAndroidApp[] = [];

  for (const app of apps) {
    const key = trustedAppKey(app.packageName, app.sha256);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ packageName: app.packageName, sha256: app.sha256 });
  }

  return result;
}

/**
 * The list as submitted and as stored: at most ten, normalised, de-duplicated.
 * The cap applies to the SUBMITTED list (before de-duplication), so eleven
 * entries are rejected even when two of them repeat.
 */
export const trustedAndroidAppsSchema = z
  .array(trustedAndroidAppSchema)
  .max(MAX_TRUSTED_ANDROID_APPS, `At most ${MAX_TRUSTED_ANDROID_APPS} trusted apps`)
  .transform(dedupeTrustedApps);

/** The stored row's value. */
export const androidAppSettingsValueSchema = z.object({
  trustedApps: trustedAndroidAppsSchema,
});

export type AndroidAppSettingsValue = z.output<typeof androidAppSettingsValueSchema>;

/** One Digital Asset Links statement, exactly as Chrome reads it. */
export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/**
 * The body of `/.well-known/assetlinks.json`: ONE statement per package, its
 * fingerprints grouped under it (a debug and a release key of the same app are
 * one statement with two fingerprints). Packages appear in the order they are
 * first listed; `[]` when nothing is trusted.
 */
export function buildAssetLinks(apps: readonly TrustedAndroidApp[]): AssetLinkStatement[] {
  const byPackage = new Map<string, string[]>();

  for (const app of apps) {
    const fingerprints = byPackage.get(app.packageName) ?? [];
    const sha256 = normalizeSha256Fingerprint(app.sha256);
    if (!fingerprints.includes(sha256)) fingerprints.push(sha256);
    byPackage.set(app.packageName, fingerprints);
  }

  return [...byPackage.entries()].map(([packageName, fingerprints]) => ({
    relation: [ASSET_LINKS_RELATION],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: fingerprints,
    },
  }));
}
