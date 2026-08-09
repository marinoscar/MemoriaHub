import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

// =============================================================================
// AES-256-GCM Secret Cipher
// =============================================================================
//
// Payload layout (all concatenated, then base64-encoded):
//   [iv: 12 bytes][authTag: 16 bytes][ciphertext: variable]
//
// Key source: SECRETS_ENCRYPTION_KEY env var (base64-encoded 32 bytes)
// Generate key: openssl rand -base64 32
// =============================================================================

const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate with: openssl rand -base64 32',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate with: openssl rand -base64 32',
    );
  }

  cachedKey = key;
  return cachedKey;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded payload containing IV, auth tag, and ciphertext.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt a base64-encoded AES-256-GCM payload produced by encryptSecret.
 * Returns the original plaintext string.
 */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// =============================================================================
// Purpose-bound sub-key derivation
// =============================================================================

/** Derived sub-keys are pure functions of the master key + purpose; cache them. */
const derivedKeys = new Map<string, Buffer>();

/**
 * Derive a 32-byte, purpose-bound sub-key from `SECRETS_ENCRYPTION_KEY`.
 *
 * Used for signing (not encrypting) values that leave the deployment — e.g. the
 * Memories email digest's stateless image and unsubscribe tokens (issue #311).
 *
 * TWO PROPERTIES MATTER, and both come from binding the purpose into the
 * derivation rather than reusing the master key directly:
 *
 *   1. DOMAIN SEPARATION. Two different purposes get two independent keys, so a
 *      token minted for one route can never be replayed against another even if
 *      an attacker finds a payload shape both would accept. Signing everything
 *      with the master key would make that a payload-parsing question rather
 *      than a cryptographic one.
 *   2. NO MASTER-KEY REUSE. The master key's job is AES-256-GCM encryption of
 *      credentials at rest. Handing the same bytes to a signing routine whose
 *      outputs are published in emails needlessly widens what an oracle against
 *      one primitive could say about the other.
 *
 * HMAC-SHA256 over a fixed label is a standard KDF construction (the extract
 * step of HKDF) and is sufficient here because the master key is already
 * full-entropy random, not a password.
 *
 * Throws the same error as encrypt/decrypt when the master key is missing or
 * malformed — fail loudly at first use rather than silently signing with a
 * degenerate key.
 */
export function deriveSubKey(purpose: string): Buffer {
  const cached = derivedKeys.get(purpose);
  if (cached) return cached;

  const derived = createHmac('sha256', getKey())
    .update(`memoriahub:subkey:v1:${purpose}`)
    .digest();
  derivedKeys.set(purpose, derived);
  return derived;
}
