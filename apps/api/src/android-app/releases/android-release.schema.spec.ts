import { releaseUploadFieldsSchema, signingSha256Schema, versionRuleRefusal } from './android-release.schema';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

const VALID = {
  packageName: 'memoriahub.marin.cr',
  versionName: '0.2.0',
  versionCode: '7',
  signingSha256: SHA,
};

describe('release upload fields', () => {
  it('coerces the multipart strings and applies the defaults', () => {
    expect(releaseUploadFieldsSchema.parse(VALID)).toEqual({
      packageName: 'memoriahub.marin.cr',
      versionName: '0.2.0',
      versionCode: 7,
      signingSha256: SHA,
      notes: null,
      makeCurrent: true,
      force: false,
    });
  });

  it('reads makeCurrent and force from "true"/"false"/"1"/"0"', () => {
    expect(releaseUploadFieldsSchema.parse({ ...VALID, makeCurrent: 'false', force: '1' })).toMatchObject({
      makeCurrent: false,
      force: true,
    });
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, makeCurrent: 'yes' }).success).toBe(false);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['a fraction', '1.5'],
    ['above Android\'s ceiling', '2100000001'],
    ['not a number', 'seven'],
  ])('rejects a versionCode that is %s', (_label, versionCode) => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode }).success).toBe(false);
  });

  it('accepts versionCode at both bounds', () => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode: '1' }).success).toBe(true);
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode: '2100000000' }).success).toBe(true);
  });

  it.each([
    ['a slash', '1.0/../x'],
    ['a quote', '1.0"'],
    ['a space', '1 0'],
    ['51 characters', 'a'.repeat(51)],
    ['an empty string', ''],
  ])('rejects a versionName with %s (it becomes a file name)', (_label, versionName) => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionName }).success).toBe(false);
  });

  it('trims notes and turns an empty note into null', () => {
    expect(releaseUploadFieldsSchema.parse({ ...VALID, notes: '  Bug fixes  ' }).notes).toBe('Bug fixes');
    expect(releaseUploadFieldsSchema.parse({ ...VALID, notes: '   ' }).notes).toBeNull();
  });

  it('rejects a package name that is not an Android application id', () => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, packageName: 'app' }).success).toBe(false);
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, packageName: '1bad.name' }).success).toBe(false);
  });

  it('keeps the package name case exactly as sent', () => {
    expect(releaseUploadFieldsSchema.parse({ ...VALID, packageName: 'MemoriaHub.marin.cr' }).packageName).toBe(
      'MemoriaHub.marin.cr',
    );
  });

  it('rejects missing required fields', () => {
    for (const key of ['packageName', 'versionName', 'versionCode', 'signingSha256'] as const) {
      const { [key]: _omitted, ...rest } = VALID;
      expect(releaseUploadFieldsSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('rejects notes over 2000 characters and unknown fields', () => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, notes: 'x'.repeat(2001) }).success).toBe(false);
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, extra: '1' }).success).toBe(false);
  });

  it('normalises a 64-hex or lowercase fingerprint to the uppercase colon form', () => {
    // The CLI sidecar sends lowercase hex with no colons (spec §14.1).
    expect(signingSha256Schema.parse('ab'.repeat(32))).toBe(SHA);
    expect(signingSha256Schema.parse(` ${'AB'.repeat(32)} `)).toBe(SHA);
    expect(signingSha256Schema.parse(SHA.toLowerCase())).toBe(SHA);
    expect(signingSha256Schema.safeParse('ab'.repeat(20)).success).toBe(false);
  });
});

describe('versionRuleRefusal', () => {
  const current = { packageName: 'memoriahub.marin.cr', versionCode: 5 };

  it('allows anything when nothing is current', () => {
    expect(versionRuleRefusal(null, { packageName: 'memoriahub.marin.cr', versionCode: 1 }, false)).toBeNull();
  });

  it('allows a strictly higher versionCode of the same package', () => {
    expect(versionRuleRefusal(current, { packageName: 'memoriahub.marin.cr', versionCode: 6 }, false)).toBeNull();
  });

  it('refuses an equal or lower versionCode of the same package', () => {
    expect(versionRuleRefusal(current, { packageName: 'memoriahub.marin.cr', versionCode: 5 }, false)).toBe(
      'RELEASE_VERSION_NOT_NEWER',
    );
    expect(versionRuleRefusal(current, { packageName: 'memoriahub.marin.cr', versionCode: 4 }, false)).toBe(
      'RELEASE_VERSION_NOT_NEWER',
    );
  });

  it('lets force override the refusal', () => {
    expect(versionRuleRefusal(current, { packageName: 'memoriahub.marin.cr', versionCode: 4 }, true)).toBeNull();
  });

  it('does not compare across packages', () => {
    expect(versionRuleRefusal(current, { packageName: 'memoriahub.marin.cr.debug', versionCode: 1 }, false)).toBeNull();
  });
});
