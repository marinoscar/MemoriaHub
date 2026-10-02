import { randomBytes } from 'node:crypto';

import { DOWNLOAD_TOKEN_KEY_PURPOSE } from './android-release.constants';
import { signDownloadToken, verifyDownloadToken } from './download-token';

const KEY = randomBytes(32);
const RELEASE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000;

function token(expiresAt = NOW + 600, key = KEY) {
  return signDownloadToken(key, { releaseId: RELEASE, userId: USER, expiresAt });
}

describe('download tokens', () => {
  it('round-trips the claims of a token signed with the same key', () => {
    expect(verifyDownloadToken(KEY, token(), NOW)).toEqual({
      ok: true,
      claims: { releaseId: RELEASE, userId: USER, expiresAt: NOW + 600 },
    });
  });

  it('is URL-safe (a single path segment)', () => {
    expect(token()).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('reports a token past its expiry as expired, and the exact expiry second too', () => {
    expect(verifyDownloadToken(KEY, token(NOW - 1), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyDownloadToken(KEY, token(NOW), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyDownloadToken(KEY, token(NOW + 1), NOW).ok).toBe(true);
  });

  it('rejects a token signed with another key as invalid, even when expired', () => {
    const other = randomBytes(32);
    expect(verifyDownloadToken(KEY, token(NOW + 600, other), NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyDownloadToken(KEY, token(NOW - 600, other), NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered signature as invalid', () => {
    const valid = token();
    const tampered = `${valid.slice(0, -2)}${valid.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyDownloadToken(KEY, tampered, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered payload (e.g. a longer expiry) as invalid', () => {
    const [payload, signature] = token().split('.');
    const bytes = Buffer.from(payload, 'base64url');
    bytes.writeUInt32BE(NOW + 999_999, 33);
    expect(verifyDownloadToken(KEY, `${bytes.toString('base64url')}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('is exactly 83 characters, under Fastify\'s default 100-character path-parameter limit', () => {
    expect(token()).toHaveLength(83);
  });

  it('round-trips with the purpose-bound sub-key, which differs from other purposes', () => {
    const original = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { deriveSubKey } = require('../../common/crypto/secret-cipher');
        const key = deriveSubKey(DOWNLOAD_TOKEN_KEY_PURPOSE);
        const signed = signDownloadToken(key, { releaseId: RELEASE, userId: USER, expiresAt: NOW + 60 });
        expect(verifyDownloadToken(key, signed, NOW).ok).toBe(true);
        expect(verifyDownloadToken(deriveSubKey('memories-digest-image'), signed, NOW)).toEqual({
          ok: false,
          reason: 'invalid',
        });
      });
    } finally {
      if (original === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = original;
    }
  });

  it('refuses to sign ids that are not UUIDs', () => {
    expect(() => signDownloadToken(KEY, { releaseId: 'x', userId: USER, expiresAt: NOW })).toThrow();
  });

  it.each([
    ['empty', ''],
    ['no signature', 'abc'],
    ['three segments', 'a.b.c'],
    ['a trailing dot', 'abc.'],
    ['too long', `${'a'.repeat(600)}.b`],
    ['a short payload', 'AAAA.AAAA'],
  ])('rejects a malformed token (%s)', (_label, value) => {
    expect(verifyDownloadToken(KEY, value, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});
