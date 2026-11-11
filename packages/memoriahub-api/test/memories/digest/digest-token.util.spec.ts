/**
 * Security tests for the digest token codec (epic #300, issue #311).
 *
 * These tokens are the ONLY access control on three unauthenticated routes, so
 * this file is deliberately adversarial: every property the routes rely on is
 * asserted here rather than assumed. No database, no network.
 */

import { createHmac } from 'node:crypto';

import {
  DIGEST_IMAGE_PURPOSE,
  DIGEST_UNSUBSCRIBE_PURPOSE,
  signDigestImageToken,
  signDigestUnsubscribeToken,
  verifyDigestImageToken,
  verifyDigestUnsubscribeToken,
} from '../../../src/memories/digest/digest-token.util.js';

/** 32 bytes: the shape of the secrets key the web edition derives its signing keys from. */
const SECRETS_KEY = Buffer.alloc(32, 7);

/**
 * The host's derivation, spelled out: the web app's `deriveSubKey(purpose)` is HMAC-SHA256 of
 * `memoriahub:subkey:v1:<purpose>` under the secrets key. The package never holds the key; it asks.
 */
const keyOf = (purpose: string): Buffer =>
  createHmac('sha256', SECRETS_KEY).update(`memoriahub:subkey:v1:${purpose}`).digest();

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Tokens minted BEFORE the slice moved (by the web app's own `digest-token.util.ts`, under the key above,
 * expiring 2100-01-01): they must still verify, or every digest e-mail already in an inbox goes dark.
 */
const LEGACY_IMAGE_TOKEN =
  'eyJtIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwiZSI6NDEwMjQ0NDgwMCwicCI6Im1lbW9yeS1kaWdlc3QtaW1hZ2UifQ.qe7XiHZPSZESC4Zh7IBRLfIn79YEzYmIY3YB0zstWpk';
const LEGACY_UNSUBSCRIBE_TOKEN =
  'eyJ1IjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiZSI6NDEwMjQ0NDgwMCwicCI6Im1lbW9yeS1kaWdlc3QtdW5zdWJzY3JpYmUifQ.CgrZs5CJr9lXJmrYc2KZCu-d7r_Q36MW_awed_HOEKU';

describe('tokens minted before the move', () => {
  it('an image token still verifies', () => {
    expect(verifyDigestImageToken(keyOf, LEGACY_IMAGE_TOKEN)).toBe(MEDIA_ID);
  });

  it('an unsubscribe token still verifies', () => {
    expect(verifyDigestUnsubscribeToken(keyOf, LEGACY_UNSUBSCRIBE_TOKEN)).toBe(USER_ID);
  });

  it('the format is unchanged: signing the same payload reproduces the legacy token byte for byte', () => {
    const realNow = Date.now;
    Date.now = () => 4_102_444_800_000 - 30 * 86_400 * 1000;
    try {
      expect(signDigestImageToken(keyOf, MEDIA_ID, 30)).toBe(LEGACY_IMAGE_TOKEN);
      expect(signDigestUnsubscribeToken(keyOf, USER_ID, 30)).toBe(LEGACY_UNSUBSCRIBE_TOKEN);
    } finally {
      Date.now = realNow;
    }
  });

  it('a token does not verify under another key', () => {
    const other = (purpose: string): Buffer => createHmac('sha256', Buffer.alloc(32, 9)).update(purpose).digest();
    expect(verifyDigestImageToken(other, LEGACY_IMAGE_TOKEN)).toBeNull();
  });
});

describe('digest image tokens', () => {
  it('round-trips the media item id', () => {
    const token = signDigestImageToken(keyOf, MEDIA_ID, 30);
    expect(verifyDigestImageToken(keyOf, token)).toBe(MEDIA_ID);
  });

  it('rejects a tampered payload', () => {
    const token = signDigestImageToken(keyOf, MEDIA_ID, 30);
    const [payload, signature] = token.split('.');

    // Re-encode the payload pointing at a DIFFERENT media item while keeping
    // the original signature — the "just swap the id in the URL" attack.
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.m = '33333333-3333-4333-8333-333333333333';
    const forged =
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') +
      '.' +
      signature;

    expect(verifyDigestImageToken(keyOf, forged)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signDigestImageToken(keyOf, MEDIA_ID, 30);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyDigestImageToken(keyOf, flipped)).toBeNull();
  });

  it('rejects an expired token', () => {
    // Negative TTL — an expiry already in the past, correctly signed.
    const token = signDigestImageToken(keyOf, MEDIA_ID, -1);
    expect(verifyDigestImageToken(keyOf, token)).toBeNull();
  });

  it('cannot have its expiry extended by editing the URL', () => {
    const token = signDigestImageToken(keyOf, MEDIA_ID, -1);
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.e = Math.floor(Date.now() / 1000) + 86_400;
    const extended =
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') +
      '.' +
      signature;

    // `exp` is inside the signed payload, so rewriting it breaks the MAC.
    expect(verifyDigestImageToken(keyOf, extended)).toBeNull();
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
      expect(verifyDigestImageToken(keyOf, bad)).toBeNull();
    }
  });

  it('honours the TTL it is given', () => {
    const token = signDigestImageToken(keyOf, MEDIA_ID, 30);
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
    const token = signDigestUnsubscribeToken(keyOf, USER_ID);
    expect(verifyDigestUnsubscribeToken(keyOf, token)).toBe(USER_ID);
  });

  it('rejects an expired token', () => {
    expect(verifyDigestUnsubscribeToken(keyOf, signDigestUnsubscribeToken(keyOf, USER_ID, -1))).toBeNull();
  });

  it('is per-user: one user\'s token never resolves to another', () => {
    const a = signDigestUnsubscribeToken(keyOf, USER_ID);
    const b = signDigestUnsubscribeToken(keyOf, '44444444-4444-4444-8444-444444444444');
    expect(verifyDigestUnsubscribeToken(keyOf, a)).toBe(USER_ID);
    expect(verifyDigestUnsubscribeToken(keyOf, b)).not.toBe(USER_ID);
  });
});

describe('cross-purpose replay', () => {
  it('an image token is not accepted as an unsubscribe token', () => {
    const image = signDigestImageToken(keyOf, MEDIA_ID, 30);
    expect(verifyDigestUnsubscribeToken(keyOf, image)).toBeNull();
  });

  it('an unsubscribe token is not accepted as an image token', () => {
    const unsub = signDigestUnsubscribeToken(keyOf, USER_ID);
    expect(verifyDigestImageToken(keyOf, unsub)).toBeNull();
  });

  it('the two purposes are distinct labels', () => {
    expect(DIGEST_IMAGE_PURPOSE).not.toBe(DIGEST_UNSUBSCRIBE_PURPOSE);
  });

  it('an unsubscribe payload re-signed under the image key still fails the purpose check', () => {
    // Simulates a future refactor that accidentally shares one key between the
    // two purposes: the in-payload `p` marker is the second, independent line
    // of defence and must still reject it.
    const unsub = signDigestUnsubscribeToken(keyOf, USER_ID);
    const payload = unsub.split('.')[0]!;
    const reSigned =
      payload +
      '.' +
      createHmac('sha256', keyOf(DIGEST_IMAGE_PURPOSE))
        .update(payload)
        .digest('base64url');

    expect(verifyDigestImageToken(keyOf, reSigned)).toBeNull();
  });
});
