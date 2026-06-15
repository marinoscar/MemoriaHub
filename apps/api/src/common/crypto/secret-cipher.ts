import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

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
