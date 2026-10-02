import {
  ClientInfoSchema,
  DeviceCodeRequestSchema,
  sanitizeReturnUri,
} from '../device-code-request.dto';

describe('sanitizeReturnUri', () => {
  // -------------------------------------------------------------------------
  // Accepted values
  // -------------------------------------------------------------------------

  describe('accepts valid schemes', () => {
    it('accepts memoriahub:// deep link', () => {
      expect(sanitizeReturnUri('memoriahub://auth/device-complete')).toBe(
        'memoriahub://auth/device-complete',
      );
    });

    it('accepts memoriahub: scheme with path', () => {
      expect(sanitizeReturnUri('memoriahub://callback?code=XYZ')).toBe(
        'memoriahub://callback?code=XYZ',
      );
    });

    it('accepts memoriahub: with uppercase (scheme check is case-insensitive)', () => {
      // The startsWith check uses .toLowerCase() so the original value is returned
      expect(sanitizeReturnUri('MEMORIAHUB://auth/device-complete')).toBe(
        'MEMORIAHUB://auth/device-complete',
      );
    });

    it('accepts an https:// URL', () => {
      expect(sanitizeReturnUri('https://app.example.com/callback')).toBe(
        'https://app.example.com/callback',
      );
    });

    it('accepts https:// with query params', () => {
      expect(sanitizeReturnUri('https://example.com/auth?redirect=true')).toBe(
        'https://example.com/auth?redirect=true',
      );
    });

    it('accepts HTTPS:// (case-insensitive scheme)', () => {
      expect(sanitizeReturnUri('HTTPS://example.com/callback')).toBe(
        'HTTPS://example.com/callback',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Rejected: disallowed schemes
  // -------------------------------------------------------------------------

  describe('rejects disallowed schemes', () => {
    it('rejects http:// (plain HTTP)', () => {
      expect(sanitizeReturnUri('http://evil.com')).toBeNull();
    });

    it('rejects file:// scheme', () => {
      expect(sanitizeReturnUri('file:///etc/passwd')).toBeNull();
    });

    it('rejects javascript: scheme', () => {
      expect(sanitizeReturnUri('javascript:alert(1)')).toBeNull();
    });

    it('rejects data: scheme', () => {
      expect(sanitizeReturnUri('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('rejects a plain relative path (no scheme)', () => {
      expect(sanitizeReturnUri('/activate')).toBeNull();
    });

    it('rejects a protocol-relative URL', () => {
      expect(sanitizeReturnUri('//evil.com')).toBeNull();
    });

    it('rejects ftp:// scheme', () => {
      expect(sanitizeReturnUri('ftp://files.example.com')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Rejected: overly long values
  // -------------------------------------------------------------------------

  describe('rejects overly long values', () => {
    it('rejects a value of exactly 513 characters', () => {
      const longUri = 'https://example.com/' + 'a'.repeat(513 - 'https://example.com/'.length);
      expect(longUri.length).toBe(513);
      expect(sanitizeReturnUri(longUri)).toBeNull();
    });

    it('accepts a value of exactly 512 characters', () => {
      const uri = 'https://example.com/' + 'a'.repeat(512 - 'https://example.com/'.length);
      expect(uri.length).toBe(512);
      expect(sanitizeReturnUri(uri)).toBe(uri);
    });

    it('rejects a very long memoriahub URI', () => {
      const longUri = 'memoriahub://auth/' + 'x'.repeat(500);
      expect(longUri.length).toBeGreaterThan(512);
      expect(sanitizeReturnUri(longUri)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Rejected: non-string / empty
  // -------------------------------------------------------------------------

  describe('rejects non-string and empty values', () => {
    it('returns null for undefined', () => {
      expect(sanitizeReturnUri(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(sanitizeReturnUri(null)).toBeNull();
    });

    it('returns null for a number', () => {
      expect(sanitizeReturnUri(42)).toBeNull();
    });

    it('returns null for an object', () => {
      expect(sanitizeReturnUri({ uri: 'memoriahub://callback' })).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(sanitizeReturnUri('')).toBeNull();
    });

    it('returns null for an array', () => {
      expect(sanitizeReturnUri(['memoriahub://callback'])).toBeNull();
    });

    it('returns null for a boolean', () => {
      expect(sanitizeReturnUri(true)).toBeNull();
    });
  });
});

describe('ClientInfoSchema (issue #499)', () => {
  it('keeps tokenType, name, hostname and platform', () => {
    const parsed = ClientInfoSchema.parse({
      tokenType: 'pat',
      name: 'MemoriaHub CLI',
      hostname: 'oscar-laptop',
      platform: 'linux',
    });
    expect(parsed).toEqual({
      tokenType: 'pat',
      name: 'MemoriaHub CLI',
      hostname: 'oscar-laptop',
      platform: 'linux',
    });
  });

  it('leaves tokenType absent when not sent (absent means session)', () => {
    expect(ClientInfoSchema.parse({ deviceName: 'TV' })).toEqual({ deviceName: 'TV' });
  });

  it('accepts tokenType "session"', () => {
    expect(ClientInfoSchema.parse({ tokenType: 'session' }).tokenType).toBe('session');
  });

  it.each(['PAT', 'admin', '', 'jwt'])('rejects unknown tokenType %p', (tokenType) => {
    expect(ClientInfoSchema.safeParse({ tokenType }).success).toBe(false);
  });

  it('trims name and enforces the 100-char cap', () => {
    expect(ClientInfoSchema.parse({ name: '  x  ' }).name).toBe('x');
    expect(ClientInfoSchema.safeParse({ name: 'n'.repeat(100) }).success).toBe(true);
    expect(ClientInfoSchema.safeParse({ name: 'n'.repeat(101) }).success).toBe(false);
  });

  it('bounds hostname (255) and platform (50)', () => {
    expect(ClientInfoSchema.safeParse({ hostname: 'h'.repeat(256) }).success).toBe(false);
    expect(ClientInfoSchema.safeParse({ platform: 'p'.repeat(51) }).success).toBe(false);
  });

  it('strips keys outside the allowlist (no passthrough)', () => {
    expect(
      ClientInfoSchema.parse({ tokenType: 'pat', isAdmin: true, scopes: ['*'] }),
    ).toEqual({ tokenType: 'pat' });
  });

  it('still rejects a non-https/memoriahub returnUri', () => {
    expect(
      ClientInfoSchema.safeParse({ returnUri: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('parses a bodyless request as {}', () => {
    expect(DeviceCodeRequestSchema.parse(undefined)).toEqual({});
  });
});
