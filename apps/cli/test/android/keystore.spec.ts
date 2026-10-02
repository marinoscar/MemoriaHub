import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PreconditionError } from '../../src/android/errors.js';
import {
  fingerprintToHex,
  generateKeystore,
  githubSecrets,
  hexToFingerprint,
  keystorePath,
  parseSha256Fingerprint,
  readCertificateSha256,
  readSigningConfig,
  signingConfigPath,
  signingEnv,
  writeSigningConfig,
} from '../../src/android/keystore.js';
import { cleanupTemp, fakeExec, SHA_COLON, SHA_HEX, tempDir, toolchain } from './fixtures.js';

afterEach(cleanupTemp);

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('keystore', () => {
  it('init refuses to overwrite an existing keystore and never runs keytool', async () => {
    const dir = tempDir();
    const path = join(dir, 'release.jks');
    writeFileSync(path, 'existing');
    const { exec, calls } = fakeExec();
    await expect(
      generateKeystore({ path, alias: 'memoriahub', storePassword: 'secret1', keyPassword: 'secret1', dname: 'CN=X' }, { exec }),
    ).rejects.toThrow(PreconditionError);
    expect(calls).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('init runs keytool RSA 4096 / 36500 days with the passwords in the environment, never the argv', async () => {
    const state = tempDir();
    const path = keystorePath({ env: { MEMORIAHUB_STATE_DIR: state } });
    const { exec, calls } = fakeExec(async (_command, args) => {
      writeFileSync(args[args.indexOf('-keystore') + 1] as string, 'jks');
      return {};
    });
    await generateKeystore({ path, alias: 'memoriahub', storePassword: 'secret1', keyPassword: 'secret1', dname: 'CN=X' }, { exec, env: {} });
    const call = calls[0]!;
    expect(call.args).toEqual(expect.arrayContaining(['-genkeypair', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '36500', '-alias', 'memoriahub']));
    expect(call.args.join(' ')).not.toContain('secret1');
    expect(Object.values(call.options?.env ?? {})).toContain('secret1');
    expect(mode(path)).toBe(0o600);
    expect(mode(join(state, 'android'))).toBe(0o700);
  });

  it('writes signing.json with mode 0600 (directory 0700) and reads it back', () => {
    const state = tempDir();
    const ctx = { env: { MEMORIAHUB_STATE_DIR: state } };
    const file = writeSigningConfig({ keystorePath: '/k.jks', keyAlias: 'memoriahub', storePassword: 'a', keyPassword: 'b', certSha256: SHA_COLON }, ctx);
    expect(file).toBe(signingConfigPath(ctx));
    expect(mode(file)).toBe(0o600);
    expect(mode(join(state, 'android'))).toBe(0o700);
    expect(readSigningConfig(ctx)).toMatchObject({ keystorePath: '/k.jks', keyAlias: 'memoriahub', certSha256: SHA_COLON });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('a missing signing.json is "not configured"; a corrupt one is an error', () => {
    const state = tempDir();
    const ctx = { env: { MEMORIAHUB_STATE_DIR: state } };
    expect(readSigningConfig(ctx)).toBeUndefined();
    writeSigningConfig({ keystorePath: '/k', keyAlias: 'a', storePassword: 'b', keyPassword: 'c' }, ctx);
    writeFileSync(signingConfigPath(ctx), '{ not json');
    expect(() => readSigningConfig(ctx)).toThrow(/not valid JSON/);
    writeFileSync(signingConfigPath(ctx), JSON.stringify({ keystorePath: '/k' }));
    expect(() => readSigningConfig(ctx)).toThrow(/missing "keyAlias"/);
  });

  it('reads the certificate SHA-256 with keytool -list -v', async () => {
    const { exec, calls } = fakeExec(toolchain());
    const sha = await readCertificateSha256({ keystorePath: '/k.jks', keyAlias: 'memoriahub', storePassword: 'pw', keyPassword: 'pw' }, { exec, env: {} });
    expect(sha).toBe(SHA_COLON);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-list', '-v', '-keystore', '/k.jks', '-alias', 'memoriahub']));
    expect(calls[0]?.args.join(' ')).not.toContain('pw ');
  });

  it('converts between the colon and hex forms', () => {
    expect(parseSha256Fingerprint(`SHA256: ${SHA_COLON.toLowerCase()}`)).toBe(SHA_COLON);
    expect(fingerprintToHex(SHA_COLON)).toBe(SHA_HEX);
    expect(hexToFingerprint(SHA_HEX)).toBe(SHA_COLON);
  });

  it('exposes the four Gradle variables and the four GitHub secrets #518 expects', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'release.jks'), Buffer.from([1, 2, 3]));
    const config = { keystorePath: join(dir, 'release.jks'), keyAlias: 'memoriahub', storePassword: 'sp', keyPassword: 'kp' };
    expect(signingEnv(config)).toEqual({
      ANDROID_KEYSTORE_FILE: config.keystorePath,
      ANDROID_KEYSTORE_PASSWORD: 'sp',
      ANDROID_KEY_ALIAS: 'memoriahub',
      ANDROID_KEY_PASSWORD: 'kp',
    });
    expect(githubSecrets(config)).toEqual([
      { name: 'ANDROID_KEYSTORE_BASE64', value: 'AQID' },
      { name: 'ANDROID_KEYSTORE_PASSWORD', value: 'sp' },
      { name: 'ANDROID_KEY_ALIAS', value: 'memoriahub' },
      { name: 'ANDROID_KEY_PASSWORD', value: 'kp' },
    ]);
  });
});
