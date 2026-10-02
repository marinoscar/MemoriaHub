import {
  ASSET_LINKS_RELATION,
  androidAppSettingsValueSchema,
  buildAssetLinks,
  normalizeSha256Fingerprint,
  trustedAndroidAppsSchema,
  trustedAppKey,
} from './android-app.schema';
import { updateAndroidAppSchema } from './dto/android-app.dto';

const SHA_A = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const SHA_B = Array.from({ length: 32 }, () => 'AB').join(':');
const PACKAGE = 'memoriahub.marin.cr';

describe('normalizeSha256Fingerprint', () => {
  it('uppercases the colon form', () => {
    expect(normalizeSha256Fingerprint(SHA_A.toLowerCase())).toBe(SHA_A);
  });

  it('turns 64 bare hex digits (either case) into the colon form', () => {
    expect(normalizeSha256Fingerprint(SHA_A.replace(/:/g, '').toLowerCase())).toBe(SHA_A);
    expect(normalizeSha256Fingerprint(` ${SHA_B.replace(/:/g, '')} `)).toBe(SHA_B);
  });

  it('leaves anything else trimmed and uppercased for the validator to reject', () => {
    expect(normalizeSha256Fingerprint(' ab:cd ')).toBe('AB:CD');
  });
});

describe('trusted Android apps schema', () => {
  it('normalises a lowercase fingerprint to uppercase and trims both fields', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: `  ${PACKAGE} `, sha256: ` ${SHA_A.toLowerCase()} ` },
    ]);

    expect(parsed).toEqual([{ packageName: PACKAGE, sha256: SHA_A }]);
  });

  it('accepts the 64-hex-digit form and stores the colon form', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: PACKAGE, sha256: SHA_A.replace(/:/g, '').toLowerCase() },
    ]);

    expect(parsed).toEqual([{ packageName: PACKAGE, sha256: SHA_A }]);
  });

  it('preserves the case of the package name', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: 'MemoriaHub.Marin.CR', sha256: SHA_A },
      { packageName: PACKAGE, sha256: SHA_A },
    ]);

    // Package names are case-sensitive: two distinct apps, neither re-cased.
    expect(parsed).toEqual([
      { packageName: 'MemoriaHub.Marin.CR', sha256: SHA_A },
      { packageName: PACKAGE, sha256: SHA_A },
    ]);
  });

  it('drops repeated pairs, including ones that differ only in fingerprint spelling, keeping order', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: PACKAGE, sha256: SHA_A },
      { packageName: `${PACKAGE}.debug`, sha256: SHA_B },
      { packageName: PACKAGE, sha256: SHA_A.toLowerCase() },
      { packageName: PACKAGE, sha256: SHA_A.replace(/:/g, '') },
    ]);

    expect(parsed).toEqual([
      { packageName: PACKAGE, sha256: SHA_A },
      { packageName: `${PACKAGE}.debug`, sha256: SHA_B },
    ]);
  });

  it('accepts an empty list', () => {
    expect(trustedAndroidAppsSchema.parse([])).toEqual([]);
  });

  it.each([
    ['a single segment', 'app'],
    ['a segment starting with a digit', 'com.1example.app'],
    ['a hyphen', 'com.my-app'],
    ['a trailing dot', 'com.example.'],
    ['a space inside', 'com.my app'],
    ['an empty string', ''],
  ])('rejects a package name with %s', (_label, packageName) => {
    expect(trustedAndroidAppsSchema.safeParse([{ packageName, sha256: SHA_A }]).success).toBe(false);
  });

  it.each([
    ['31 bytes', SHA_A.slice(3)],
    ['63 hex digits', SHA_A.replace(/:/g, '').slice(1)],
    ['a non-hex byte', SHA_A.replace(/^00/, 'ZZ')],
    ['a SHA-1 fingerprint', Array.from({ length: 20 }, () => 'AA').join(':')],
    ['an empty string', ''],
  ])('rejects a fingerprint with %s', (_label, sha256) => {
    expect(trustedAndroidAppsSchema.safeParse([{ packageName: PACKAGE, sha256 }]).success).toBe(false);
  });

  it('rejects more than ten apps', () => {
    const apps = Array.from({ length: 11 }, (_, i) => ({ packageName: `com.example.app${i}`, sha256: SHA_A }));

    expect(trustedAndroidAppsSchema.safeParse(apps).success).toBe(false);
    expect(trustedAndroidAppsSchema.safeParse(apps.slice(0, 10)).success).toBe(true);
  });

  it('requires trustedApps in the PUT body and rejects unknown keys', () => {
    expect(updateAndroidAppSchema.safeParse({}).success).toBe(false);
    expect(updateAndroidAppSchema.safeParse({ trustedApps: [], extra: true }).success).toBe(false);
    expect(updateAndroidAppSchema.parse({ trustedApps: [] })).toEqual({ trustedApps: [] });
  });

  it('validates the stored row value the same way', () => {
    expect(androidAppSettingsValueSchema.safeParse({ trustedApps: 'nope' }).success).toBe(false);
    expect(androidAppSettingsValueSchema.parse({ trustedApps: [{ packageName: PACKAGE, sha256: SHA_A }] })).toEqual({
      trustedApps: [{ packageName: PACKAGE, sha256: SHA_A }],
    });
  });
});

describe('trustedAppKey', () => {
  it('compares fingerprints however they are spelled but package names case-sensitively', () => {
    expect(trustedAppKey(PACKAGE, SHA_A)).toBe(trustedAppKey(PACKAGE, SHA_A.replace(/:/g, '').toLowerCase()));
    expect(trustedAppKey(PACKAGE, SHA_A)).not.toBe(trustedAppKey(PACKAGE.toUpperCase(), SHA_A));
  });
});

describe('buildAssetLinks', () => {
  it('is an empty array when nothing is trusted', () => {
    expect(buildAssetLinks([])).toEqual([]);
  });

  it('emits one statement per package, grouping its fingerprints in listed order', () => {
    const statements = buildAssetLinks([
      { packageName: PACKAGE, sha256: SHA_A },
      { packageName: `${PACKAGE}.debug`, sha256: SHA_A },
      { packageName: PACKAGE, sha256: SHA_B },
    ]);

    expect(statements).toEqual([
      {
        relation: [ASSET_LINKS_RELATION],
        target: {
          namespace: 'android_app',
          package_name: PACKAGE,
          sha256_cert_fingerprints: [SHA_A, SHA_B],
        },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: `${PACKAGE}.debug`,
          sha256_cert_fingerprints: [SHA_A],
        },
      },
    ]);
  });

  it('never repeats a fingerprint within a statement', () => {
    const [statement] = buildAssetLinks([
      { packageName: PACKAGE, sha256: SHA_A },
      { packageName: PACKAGE, sha256: SHA_A.toLowerCase() },
    ]);

    expect(statement.target.sha256_cert_fingerprints).toEqual([SHA_A]);
  });
});
