import { createHmac, randomBytes } from 'crypto';

/**
 * Validates that a `returnTo` value is a safe same-site relative path.
 *
 * Rules:
 * - Must be a non-empty string
 * - Must start with a single '/'
 * - Must NOT start with '//' (protocol-relative URL — open redirect)
 * - Must NOT start with '/\' (Windows path trick)
 * - Must NOT contain '://' (absolute URL scheme)
 * - Must NOT contain backslashes
 * - Must NOT contain control characters (0x00–0x1f, 0x7f)
 *
 * @returns The original string if valid, or null if invalid/absent.
 */
export function sanitizeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.startsWith('/\\')) return null;
  // Detect embedded scheme (e.g. '/redirect?to=http://evil.com')
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  if (value.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

/**
 * Encodes the OAuth `state` parameter with an HMAC-SHA256 signature to prevent
 * tampering. A random nonce is included so replayed states are distinguishable.
 *
 * Format: `base64url(JSON.stringify({ returnTo, nonce })) + '.' + HMAC_SHA256(payload, secret)`
 *
 * @param returnTo - A sanitized same-site path, or null if absent.
 * @param secret   - The application JWT secret used to sign the payload.
 */
export function encodeOAuthState(returnTo: string | null, secret: string): string {
  const nonce = randomBytes(16).toString('hex');
  const payload = Buffer.from(JSON.stringify({ returnTo, nonce })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Decodes and verifies a signed OAuth `state` parameter produced by `encodeOAuthState`.
 * Returns `{ returnTo: null }` when the signature is invalid, the state is absent,
 * or the embedded `returnTo` fails the same-site path validation.
 *
 * @param state  - The raw state string from `req.query.state` (Google's callback).
 * @param secret - The application JWT secret used to verify the signature.
 */
export function decodeOAuthState(
  state: unknown,
  secret: string,
): { returnTo: string | null } {
  if (typeof state !== 'string' || !state) return { returnTo: null };

  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) return { returnTo: null };

  const payload = state.substring(0, dotIndex);
  const signature = state.substring(dotIndex + 1);

  // Verify HMAC signature
  const expectedSignature = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature !== expectedSignature) return { returnTo: null };

  // Decode and re-validate returnTo (defense in depth)
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString()) as unknown;
    if (typeof json !== 'object' || json === null) return { returnTo: null };
    const returnTo = sanitizeReturnTo((json as Record<string, unknown>)['returnTo']);
    return { returnTo };
  } catch {
    return { returnTo: null };
  }
}
