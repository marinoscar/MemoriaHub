// =============================================================================
// Memory Digest Tokens — stateless, HMAC-signed capabilities (epic #300, #311)
// =============================================================================
//
// Two things in the digest email must work for a recipient who is NOT logged in
// and may open the mail weeks later:
//
//   1. THE COVER IMAGES. A signed gallery thumbnail URL expires in 24h — useless
//      in an inbox. Attaching bytes was rejected (multi-MB mails, SES size
//      limits), and minting a `MediaShare` row per image was rejected as DB
//      litter with revocation churn. So each image is addressed by a token that
//      IS the capability: `{ m: mediaItemId, e: exp }`, signed.
//   2. THE UNSUBSCRIBE LINK. RFC 8058 one-click unsubscribe must work with no
//      session at all: `{ u: userId, p: 'memory-digest', e: exp }`, signed.
//
// FORMAT: `base64url(JSON payload)` + '.' + `base64url(HMAC-SHA256(payload))`.
// The payload is readable, which is fine and deliberate — it carries an opaque
// UUID and an expiry, never a secret — and the signature is what makes it
// unforgeable. Same shape as the OAuth `state` token (oauth-state.util.ts).
//
// SECURITY PROPERTIES, each load-bearing:
//   - KEYED PER PURPOSE. Image and unsubscribe tokens are signed with different
//     `deriveSubKey()` sub-keys, so an image token can never be replayed as an
//     unsubscribe token (or vice versa) even though both are base64url blobs of
//     the same shape. The purpose is ALSO carried in the payload and re-checked
//     — belt and braces, so a future refactor that accidentally shares a key
//     still fails closed.
//   - CONSTANT-TIME COMPARISON. Signatures are compared with
//     `crypto.timingSafeEqual` over equal-length buffers, never `===`, so a
//     forger cannot learn a valid prefix by measuring response times.
//   - EXPIRY IS INSIDE THE SIGNATURE. `exp` is part of the signed payload, so it
//     cannot be extended by editing the URL. Expiry is the ONLY revocation
//     mechanism (there is no token table by design), which is exactly why the
//     image capability is deliberately narrow: it grants the THUMBNAIL of one
//     media item, never the original, and never anything else about it.
//   - EVERY FAILURE IS THE SAME FAILURE. Malformed, tampered, wrong-purpose and
//     expired tokens all return `null`; callers turn that into a generic 404, so
//     the route is not an oracle for which media ids or user ids exist.
// =============================================================================

import { createHmac, timingSafeEqual } from 'crypto';

import { deriveSubKey } from '../../common/crypto/secret-cipher';

/** Signing purposes. Each maps to an independent derived key. */
export const DIGEST_IMAGE_PURPOSE = 'memory-digest-image';
export const DIGEST_UNSUBSCRIBE_PURPOSE = 'memory-digest-unsubscribe';

/**
 * Unsubscribe-token lifetime. Long enough that a digest sitting unread in an
 * inbox still unsubscribes correctly months later — the alternative (a dead
 * link) trains people to press "spam" instead, which is far more damaging to a
 * deployment's sender reputation than a long-lived opt-out capability whose
 * entire power is "stop emailing this user".
 */
export const UNSUBSCRIBE_TTL_DAYS = 90;

/** Payload of an image token. Short keys keep the URL short. */
interface ImageTokenPayload {
  /** Media item whose THUMBNAIL may be served. */
  m: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Purpose marker, re-checked on verify. */
  p: typeof DIGEST_IMAGE_PURPOSE;
}

/** Payload of an unsubscribe token. */
interface UnsubscribeTokenPayload {
  /** User being unsubscribed. */
  u: string;
  /** Expiry, epoch seconds. */
  e: number;
  p: typeof DIGEST_UNSUBSCRIBE_PURPOSE;
}

// -----------------------------------------------------------------------------
// Generic sign / verify
// -----------------------------------------------------------------------------

function sign(purpose: string, payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', deriveSubKey(purpose))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

/**
 * Verify a token's signature and decode its payload, or return `null`.
 *
 * Returns `null` for EVERY failure mode without distinguishing them — see the
 * header's "every failure is the same failure" note.
 */
function verify<T>(purpose: string, token: unknown): T | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return null;
  }

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const encoded = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = createHmac('sha256', deriveSubKey(purpose))
    .update(encoded)
    .digest('base64url');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first — that comparison leaks only the length of a base64url SHA-256
  // digest, which is a constant anyway.
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  try {
    const json: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!json || typeof json !== 'object') return null;

    const record = json as Record<string, unknown>;
    if (record['p'] !== purpose) return null;

    const exp = record['e'];
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (exp * 1000 <= Date.now()) return null;

    return json as T;
  } catch {
    return null;
  }
}

/** Epoch seconds `days` from now, rounded down. */
function expiryInDays(days: number): number {
  return Math.floor(Date.now() / 1000) + Math.round(days * 24 * 60 * 60);
}

// -----------------------------------------------------------------------------
// Image tokens
// -----------------------------------------------------------------------------

/**
 * Mint a capability to read ONE media item's thumbnail.
 *
 * @param ttlDays `memories.digest.imageTokenTtlDays` (bounded 7–90 by the
 *                settings schema). Sending an image token that outlives the
 *                mail's usefulness is the whole reason the setting exists.
 */
export function signDigestImageToken(mediaItemId: string, ttlDays: number): string {
  const payload: ImageTokenPayload = {
    m: mediaItemId,
    e: expiryInDays(ttlDays),
    p: DIGEST_IMAGE_PURPOSE,
  };
  return sign(DIGEST_IMAGE_PURPOSE, payload);
}

/** Verify an image token; returns the media item id or `null`. */
export function verifyDigestImageToken(token: unknown): string | null {
  const payload = verify<ImageTokenPayload>(DIGEST_IMAGE_PURPOSE, token);
  if (!payload) return null;
  return typeof payload.m === 'string' && payload.m.length > 0 ? payload.m : null;
}

// -----------------------------------------------------------------------------
// Unsubscribe tokens
// -----------------------------------------------------------------------------

/** Mint a login-free unsubscribe capability for one user. */
export function signDigestUnsubscribeToken(
  userId: string,
  ttlDays: number = UNSUBSCRIBE_TTL_DAYS,
): string {
  const payload: UnsubscribeTokenPayload = {
    u: userId,
    e: expiryInDays(ttlDays),
    p: DIGEST_UNSUBSCRIBE_PURPOSE,
  };
  return sign(DIGEST_UNSUBSCRIBE_PURPOSE, payload);
}

/** Verify an unsubscribe token; returns the user id or `null`. */
export function verifyDigestUnsubscribeToken(token: unknown): string | null {
  const payload = verify<UnsubscribeTokenPayload>(DIGEST_UNSUBSCRIBE_PURPOSE, token);
  if (!payload) return null;
  return typeof payload.u === 'string' && payload.u.length > 0 ? payload.u : null;
}
