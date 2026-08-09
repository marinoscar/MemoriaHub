/**
 * Security tests for the digest token codec (epic #300, issue #311).
 *
 * These tokens are the ONLY access control on three unauthenticated routes, so
 * this file is deliberately adversarial: every property the routes rely on is
 * asserted here rather than assumed. No database, no network.
 */

import {
  DIGEST_IMAGE_PURPOSE,
  DIGEST_UNSUBSCRIBE_PURPOSE,
  signDigestImageToken,
  signDigestUnsubscribeToken,
  verifyDigestImageToken,
  verifyDigestUnsubscribeToken,
} from './digest-token.util';

/** 32 random bytes, base64 — the shape SECRETS_ENCRYPTION_KEY must have. */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
});

describe('digest image tokens', () => {
  it('round-trips the media item id', () => {
    const token = signDigestImageToken(MEDIA_ID, 30);
    expect(verifyDigestImageToken(token)).toBe(MEDIA_ID);
  });

  it('rejects a tampered payload', () => {
    const token = signDigestImageToken(MEDIA_ID, 30);
    const [payload, signature] = token.split('.');

    // Re-encode the payload pointing at a DIFFERENT media item while keeping
    // the original signature — the "just swap the id in the URL" attack.
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.m = '33333333-3333-4333-8333-333333333333';
    const forged =
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') +
      '.' +
      signature;

    expect(verifyDigestImageToken(forged)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signDigestImageToken(MEDIA_ID, 30);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyDigestImageToken(flipped)).toBeNull();
  });

  it('rejects an expired token', () => {
    // Negative TTL — an expiry already in the past, correctly signed.
    const token = signDigestImageToken(MEDIA_ID, -1);
    expect(verifyDigestImageToken(token)).toBeNull();
  });

  it('cannot have its expiry extended by editing the URL', () => {
    const token = signDigestImageToken(MEDIA_ID, -1);
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.e = Math.floor(Date.now() / 1000) + 86_400;
    const extended =
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') +
      '.' +
      signature;

    // `exp` is inside the signed payload, so rewriting it breaks the MAC.
    expect(verifyDigestImageToken(extended)).toBeNull();
  });

  it('rejects malformed input of every shape without throwing', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      '.',
      'nodot',
      'a.',
      '.b',
      'not-base64.also-not',
      'a'.repeat(5000),
    ]) {
      expect(verifyDigestImageToken(bad)).toBeNull();
    }
  });

  it('honours the TTL it is given', () => {
    const token = signDigestImageToken(MEDIA_ID, 30);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
    );
    const days = (payload.e - Math.floor(Date.now() / 1000)) / 86_400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('digest unsubscribe tokens', () => {
  it('round-trips the user id', () => {
    const token = signDigestUnsubscribeToken(USER_ID);
    expect(verifyDigestUnsubscribeToken(token)).toBe(USER_ID);
  });

  it('rejects an expired token', () => {
    expect(verifyDigestUnsubscribeToken(signDigestUnsubscribeToken(USER_ID, -1))).toBeNull();
  });

  it('is per-user: one user\'s token never resolves to another', () => {
    const a = signDigestUnsubscribeToken(USER_ID);
    const b = signDigestUnsubscribeToken('44444444-4444-4444-8444-444444444444');
    expect(verifyDigestUnsubscribeToken(a)).toBe(USER_ID);
    expect(verifyDigestUnsubscribeToken(b)).not.toBe(USER_ID);
  });
});

describe('cross-purpose replay', () => {
  it('an image token is not accepted as an unsubscribe token', () => {
    const image = signDigestImageToken(MEDIA_ID, 30);
    expect(verifyDigestUnsubscribeToken(image)).toBeNull();
  });

  it('an unsubscribe token is not accepted as an image token', () => {
    const unsub = signDigestUnsubscribeToken(USER_ID);
    expect(verifyDigestImageToken(unsub)).toBeNull();
  });

  it('the two purposes are distinct labels', () => {
    expect(DIGEST_IMAGE_PURPOSE).not.toBe(DIGEST_UNSUBSCRIBE_PURPOSE);
  });

  it('an unsubscribe payload re-signed under the image key still fails the purpose check', () => {
    // Simulates a future refactor that accidentally shares one key between the
    // two purposes: the in-payload `p` marker is the second, independent line
    // of defence and must still reject it.
    const unsub = signDigestUnsubscribeToken(USER_ID);
    const payload = unsub.split('.')[0]!;
    const { createHmac } = require('crypto') as typeof import('crypto');
    const {
      deriveSubKey,
    } = require('../../common/crypto/secret-cipher') as typeof import('../../common/crypto/secret-cipher');
    const reSigned =
      payload +
      '.' +
      createHmac('sha256', deriveSubKey(DIGEST_IMAGE_PURPOSE))
        .update(payload)
        .digest('base64url');

    expect(verifyDigestImageToken(reSigned)).toBeNull();
  });
});
