/**
 * Unit tests for the AES-256-GCM secret cipher.
 *
 * IMPORTANT: The module caches the derived key in a module-level `let cachedKey`.
 * Every test group that needs a fresh env key MUST use jest.isolateModules() to
 * reset that cache. Do NOT set process.env once globally and call the shared exports
 * — the cached key will silently persist between tests.
 */

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI='; // 44 chars → 32 bytes
const ANOTHER_VALID_KEY = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY='; // different 32-byte key

describe('secret-cipher', () => {
  const originalKey = process.env.SECRETS_ENCRYPTION_KEY;

  afterEach(() => {
    // Restore original env after each test block
    if (originalKey === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = originalKey;
    }
  });

  describe('round-trip encrypt/decrypt', () => {
    it('decrypts ciphertext back to the original plaintext', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');
        const plaintext = 'sk-my-super-secret-api-key-12345';
        const ciphertext = encryptSecret(plaintext);
        const result = decryptSecret(ciphertext);
        expect(result).toBe(plaintext);
      });
    });

    it('round-trips an empty string', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');
        const plaintext = '';
        const ciphertext = encryptSecret(plaintext);
        expect(decryptSecret(ciphertext)).toBe(plaintext);
      });
    });

    it('round-trips a unicode string', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');
        const plaintext = 'hola 😀 日本語 "quotes" \'apostrophe\'';
        expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
      });
    });
  });

  describe('ciphertext properties', () => {
    it('ciphertext (base64) is not equal to the original plaintext', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret } = require('./secret-cipher');
        const plaintext = 'my-plaintext-value';
        const ciphertext = encryptSecret(plaintext);
        expect(ciphertext).not.toBe(plaintext);
      });
    });

    it('produces different ciphertext for the same plaintext each call (random IV)', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret } = require('./secret-cipher');
        const plaintext = 'same-text';
        const ct1 = encryptSecret(plaintext);
        const ct2 = encryptSecret(plaintext);
        expect(ct1).not.toBe(ct2);
      });
    });
  });

  describe('tampered payload', () => {
    it('throws when a byte in the ciphertext buffer is mutated (GCM auth tag fails)', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');
        const ciphertext = encryptSecret('original plaintext');

        // Decode, mutate a byte in the auth tag region (bytes 12-27), re-encode
        const buf = Buffer.from(ciphertext, 'base64');
        buf[13] ^= 0xff; // flip byte 13 (inside auth tag)
        const tampered = buf.toString('base64');

        expect(() => decryptSecret(tampered)).toThrow();
      });
    });

    it('throws when the ciphertext section is mutated', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');
        const ciphertext = encryptSecret('another secret value');

        const buf = Buffer.from(ciphertext, 'base64');
        // Mutate a byte in the ciphertext section (after IV(12) + authTag(16) = byte 28+)
        if (buf.length > 28) {
          buf[28] ^= 0xff;
        }
        const tampered = buf.toString('base64');

        expect(() => decryptSecret(tampered)).toThrow();
      });
    });
  });

  describe('missing key', () => {
    it('encryptSecret throws when SECRETS_ENCRYPTION_KEY is not set', () => {
      delete process.env.SECRETS_ENCRYPTION_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret } = require('./secret-cipher');
        expect(() => encryptSecret('anything')).toThrow('SECRETS_ENCRYPTION_KEY');
      });
    });

    it('decryptSecret throws when SECRETS_ENCRYPTION_KEY is not set', () => {
      delete process.env.SECRETS_ENCRYPTION_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { decryptSecret } = require('./secret-cipher');
        expect(() => decryptSecret('anypayload')).toThrow('SECRETS_ENCRYPTION_KEY');
      });
    });
  });

  describe('invalid key (wrong length)', () => {
    it('throws when the decoded key is not 32 bytes', () => {
      // Base64 of a 16-byte string — too short
      const shortKey = Buffer.from('1234567890123456').toString('base64');
      process.env.SECRETS_ENCRYPTION_KEY = shortKey;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret } = require('./secret-cipher');
        expect(() => encryptSecret('test')).toThrow('SECRETS_ENCRYPTION_KEY');
      });
    });

    it('throws when the key decodes to more than 32 bytes', () => {
      // 48-byte key — too long
      const longKey = Buffer.alloc(48, 'x').toString('base64');
      process.env.SECRETS_ENCRYPTION_KEY = longKey;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret } = require('./secret-cipher');
        expect(() => encryptSecret('test')).toThrow('SECRETS_ENCRYPTION_KEY');
      });
    });
  });

  describe('key caching behaviour', () => {
    it('uses the key that was loaded on first call even if env changes later (cache hit)', () => {
      process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { encryptSecret, decryptSecret } = require('./secret-cipher');

        const plaintext = 'cached-key-test';
        const ct = encryptSecret(plaintext);

        // Mutate the env after first call — the cache should still hold the original key
        process.env.SECRETS_ENCRYPTION_KEY = ANOTHER_VALID_KEY;

        // Decryption should still succeed because the cached key is still the original
        expect(decryptSecret(ct)).toBe(plaintext);
      });
    });
  });
});
