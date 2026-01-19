/**
 * Settings Encryption
 *
 * Provides encryption/decryption for sensitive settings values like
 * SMTP passwords, API keys, and other credentials.
 *
 * Uses AES-256-GCM for authenticated encryption.
 * Encryption key should be provided via environment variable.
 */

import crypto from 'crypto';
import { logger } from '../logging/logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
// Note: AUTH_TAG_LENGTH is implicitly 16 bytes for GCM mode

/**
 * Encryption key from environment
 * Should be a 32-byte (256-bit) key, base64 encoded
 * Generate with: openssl rand -base64 32
 */
function getEncryptionKey(): Buffer | null {
  const keyEnv = process.env.SETTINGS_ENCRYPTION_KEY;

  if (!keyEnv) {
    return null;
  }

  try {
    const key = Buffer.from(keyEnv, 'base64');
    if (key.length !== 32) {
      logger.warn(
        { keyLength: key.length },
        'SETTINGS_ENCRYPTION_KEY should be 32 bytes (256 bits)'
      );
      return null;
    }
    return key;
  } catch (error) {
    logger.error(
      { error },
      'Failed to parse SETTINGS_ENCRYPTION_KEY - should be base64 encoded'
    );
    return null;
  }
}

/**
 * Check if encryption is enabled
 */
export function isEncryptionEnabled(): boolean {
  return getEncryptionKey() !== null;
}

/**
 * Encrypt a sensitive value
 *
 * @param plaintext The value to encrypt
 * @returns Encrypted value as "iv:authTag:ciphertext" (base64 encoded parts)
 * @throws If encryption key is not configured
 */
export function encryptSensitive(plaintext: string): string {
  const key = getEncryptionKey();

  if (!key) {
    logger.warn(
      'SETTINGS_ENCRYPTION_KEY not configured - storing value unencrypted'
    );
    // Return with a prefix so we know it's not encrypted
    return `plain:${Buffer.from(plaintext).toString('base64')}`;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return `enc:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a sensitive value
 *
 * @param encrypted The encrypted value (from encryptSensitive)
 * @returns Decrypted plaintext
 * @throws If decryption fails or key is not configured
 */
export function decryptSensitive(encrypted: string): string {
  // Handle unencrypted values (for backwards compatibility or when encryption disabled)
  if (encrypted.startsWith('plain:')) {
    return Buffer.from(encrypted.slice(6), 'base64').toString('utf8');
  }

  // Handle raw values (legacy, before encryption was added)
  if (!encrypted.startsWith('enc:')) {
    return encrypted;
  }

  const key = getEncryptionKey();

  if (!key) {
    throw new Error(
      'Cannot decrypt: SETTINGS_ENCRYPTION_KEY not configured'
    );
  }

  const parts = encrypted.slice(4).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Mask a sensitive value for display (e.g., in API responses)
 *
 * @param value The value to mask
 * @param visibleChars Number of trailing characters to show (default: 4)
 * @returns Masked value like "••••••••abcd"
 */
export function maskSensitive(value: string | undefined | null, visibleChars = 4): string {
  if (!value) {
    return '';
  }

  if (value.length <= visibleChars) {
    return '•'.repeat(8);
  }

  const visible = value.slice(-visibleChars);
  const masked = '•'.repeat(Math.min(value.length - visibleChars, 12));
  return `${masked}${visible}`;
}

/**
 * Process settings object, encrypting sensitive fields
 *
 * @param settings Settings object
 * @param sensitiveFields List of field names to encrypt
 * @returns Settings with sensitive fields encrypted
 */
export function encryptSettingsFields<T extends Record<string, unknown>>(
  settings: T,
  sensitiveFields: string[]
): T {
  const result: Record<string, unknown> = { ...settings };

  for (const field of sensitiveFields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0) {
      // Only encrypt if not already encrypted
      if (!value.startsWith('enc:') && !value.startsWith('plain:')) {
        result[field] = encryptSensitive(value);
      }
    }
  }

  return result as T;
}

/**
 * Process settings object, decrypting sensitive fields
 *
 * @param settings Settings object
 * @param sensitiveFields List of field names to decrypt
 * @returns Settings with sensitive fields decrypted
 */
export function decryptSettingsFields<T extends Record<string, unknown>>(
  settings: T,
  sensitiveFields: string[]
): T {
  const result: Record<string, unknown> = { ...settings };

  for (const field of sensitiveFields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0) {
      try {
        result[field] = decryptSensitive(value);
      } catch (error) {
        logger.error(
          { field, error },
          'Failed to decrypt settings field'
        );
        // Keep the original value if decryption fails
      }
    }
  }

  return result as T;
}

/**
 * Process settings object, masking sensitive fields for API response
 *
 * @param settings Settings object
 * @param maskedFields List of field names to mask
 * @returns Settings with sensitive fields masked
 */
export function maskSettingsFields<T extends Record<string, unknown>>(
  settings: T,
  maskedFields: string[]
): T {
  const result: Record<string, unknown> = { ...settings };

  for (const field of maskedFields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0) {
      // First decrypt if encrypted, then mask
      let plainValue = value;
      if (value.startsWith('enc:') || value.startsWith('plain:')) {
        try {
          plainValue = decryptSensitive(value);
        } catch {
          // If decryption fails, mask the raw value
        }
      }
      result[field] = maskSensitive(plainValue);
    }
  }

  return result as T;
}
