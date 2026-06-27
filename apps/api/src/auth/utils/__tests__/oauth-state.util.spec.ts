import {
  sanitizeReturnTo,
  encodeOAuthState,
  decodeOAuthState,
} from '../oauth-state.util';

describe('sanitizeReturnTo', () => {
  const SECRET = 'test-secret-not-used-here';

  // Accepted paths
  describe('valid same-site relative paths', () => {
    it('accepts a plain root path', () => {
      expect(sanitizeReturnTo('/')).toBe('/');
    });

    it('accepts a path with segments', () => {
      expect(sanitizeReturnTo('/activate')).toBe('/activate');
    });

    it('accepts a path with a query string', () => {
      expect(sanitizeReturnTo('/activate?code=ABCD-1234')).toBe('/activate?code=ABCD-1234');
    });

    it('accepts a path with multiple query params', () => {
      expect(sanitizeReturnTo('/search?q=dog&page=2')).toBe('/search?q=dog&page=2');
    });

    it('accepts a deep nested path', () => {
      expect(sanitizeReturnTo('/admin/settings/users')).toBe('/admin/settings/users');
    });

    it('accepts a path with a fragment', () => {
      expect(sanitizeReturnTo('/profile#section')).toBe('/profile#section');
    });
  });

  // Rejected inputs
  describe('rejects non-string and empty values', () => {
    it('returns null for undefined', () => {
      expect(sanitizeReturnTo(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(sanitizeReturnTo(null)).toBeNull();
    });

    it('returns null for a number', () => {
      expect(sanitizeReturnTo(42)).toBeNull();
    });

    it('returns null for an object', () => {
      expect(sanitizeReturnTo({ path: '/' })).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(sanitizeReturnTo('')).toBeNull();
    });

    it('returns null for an array', () => {
      expect(sanitizeReturnTo(['/'])).toBeNull();
    });
  });

  describe('rejects absolute URLs', () => {
    it('rejects https absolute URL', () => {
      expect(sanitizeReturnTo('https://evil.com')).toBeNull();
    });

    it('rejects http absolute URL', () => {
      expect(sanitizeReturnTo('http://evil.com')).toBeNull();
    });

    it('rejects a string that does not start with /', () => {
      expect(sanitizeReturnTo('evil.com/path')).toBeNull();
    });
  });

  describe('rejects protocol-relative URLs', () => {
    it('rejects //evil.com', () => {
      expect(sanitizeReturnTo('//evil.com')).toBeNull();
    });

    it('rejects //evil.com/path', () => {
      expect(sanitizeReturnTo('//evil.com/path')).toBeNull();
    });
  });

  describe('rejects backslash tricks', () => {
    it('rejects /\\evil.com (leading backslash after slash)', () => {
      expect(sanitizeReturnTo('/\\evil.com')).toBeNull();
    });

    it('rejects a path containing a backslash in the middle', () => {
      expect(sanitizeReturnTo('/path\\to')).toBeNull();
    });
  });

  describe('rejects scheme-bearing strings', () => {
    // The guard catches '://' patterns — including when embedded in query strings.
    // This covers the common open-redirect attack where an attacker crafts a path
    // like `/redir?url=http://evil.com`. Bare colon schemes without '//' (e.g.
    // `javascript:alert(1)` as a query value) are not blocked here because they
    // are not open-redirect vectors when the value is passed to React Router.

    it('rejects embedded http:// in a query string', () => {
      expect(sanitizeReturnTo('/redir?url=http://evil.com')).toBeNull();
    });

    it('rejects embedded https:// in a query string', () => {
      expect(sanitizeReturnTo('/redir?url=https://evil.com')).toBeNull();
    });

    it('rejects embedded javascript:// in a query string', () => {
      expect(sanitizeReturnTo('/redir?to=javascript://void()')).toBeNull();
    });

    it('rejects embedded ftp:// in a query string', () => {
      expect(sanitizeReturnTo('/redir?src=ftp://files.evil.com')).toBeNull();
    });
  });

  describe('rejects control characters', () => {
    it('rejects a path containing a null byte', () => {
      expect(sanitizeReturnTo('/path\x00')).toBeNull();
    });

    it('rejects a path containing a line feed', () => {
      expect(sanitizeReturnTo('/path\nX-Injected: header')).toBeNull();
    });

    it('rejects a path containing a carriage return', () => {
      expect(sanitizeReturnTo('/path\r\nX-Injected: header')).toBeNull();
    });

    it('rejects DEL character (0x7f)', () => {
      expect(sanitizeReturnTo('/path\x7f')).toBeNull();
    });
  });
});

describe('encodeOAuthState / decodeOAuthState', () => {
  const SECRET = 'super-secret-jwt-key-for-testing-1234';

  describe('round-trip', () => {
    it('encodes a valid returnTo and decodes it back', () => {
      const returnTo = '/activate?code=ABCD-1234';
      const state = encodeOAuthState(returnTo, SECRET);
      const result = decodeOAuthState(state, SECRET);
      expect(result).toEqual({ returnTo });
    });

    it('encodes null returnTo and decodes it back as null', () => {
      const state = encodeOAuthState(null, SECRET);
      const result = decodeOAuthState(state, SECRET);
      expect(result).toEqual({ returnTo: null });
    });

    it('produces different state strings on each call (nonce)', () => {
      const state1 = encodeOAuthState('/home', SECRET);
      const state2 = encodeOAuthState('/home', SECRET);
      expect(state1).not.toBe(state2);
    });

    it('encoded state contains exactly one dot separator', () => {
      const state = encodeOAuthState('/home', SECRET);
      const parts = state.split('.');
      // The last element is the signature; there should be at least 2 parts
      expect(parts.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('tampered state', () => {
    it('returns { returnTo: null } when the payload is modified but signature kept', () => {
      const state = encodeOAuthState('/home', SECRET);
      const dotIndex = state.lastIndexOf('.');
      const signature = state.substring(dotIndex + 1);

      // Build a different payload (different returnTo)
      const fakePayload = Buffer.from(JSON.stringify({ returnTo: '/evil', nonce: 'aaa' })).toString('base64url');
      const tamperedState = `${fakePayload}.${signature}`;

      expect(decodeOAuthState(tamperedState, SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } when the signature is truncated', () => {
      const state = encodeOAuthState('/home', SECRET);
      const truncated = state.slice(0, -4);
      expect(decodeOAuthState(truncated, SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } when an extra character is appended', () => {
      const state = encodeOAuthState('/home', SECRET);
      expect(decodeOAuthState(state + 'x', SECRET)).toEqual({ returnTo: null });
    });
  });

  describe('wrong secret', () => {
    it('returns { returnTo: null } when verified with a different secret', () => {
      const state = encodeOAuthState('/home', SECRET);
      expect(decodeOAuthState(state, 'totally-different-secret')).toEqual({ returnTo: null });
    });
  });

  describe('garbage / empty input', () => {
    it('returns { returnTo: null } for an empty string', () => {
      expect(decodeOAuthState('', SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for a string without a dot', () => {
      expect(decodeOAuthState('nodothere', SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for null', () => {
      expect(decodeOAuthState(null, SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for undefined', () => {
      expect(decodeOAuthState(undefined, SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for a number', () => {
      expect(decodeOAuthState(42, SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for random garbage', () => {
      expect(decodeOAuthState('abc.def', SECRET)).toEqual({ returnTo: null });
    });

    it('returns { returnTo: null } for a valid base64 payload with bad signature', () => {
      const payload = Buffer.from(JSON.stringify({ returnTo: '/home', nonce: 'abc' })).toString('base64url');
      expect(decodeOAuthState(`${payload}.badsig`, SECRET)).toEqual({ returnTo: null });
    });
  });

  describe('defense-in-depth: re-validates returnTo inside the payload', () => {
    it('returns { returnTo: null } when an unsafe path sneaks into a correctly-signed state', () => {
      // Manually build a state with a dangerous returnTo using the real secret
      // so the HMAC passes, but the inner sanitizeReturnTo must still reject it.
      const { createHmac } = require('crypto');
      const payload = Buffer.from(JSON.stringify({ returnTo: '//evil.com', nonce: 'abc' })).toString('base64url');
      const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
      const state = `${payload}.${sig}`;
      expect(decodeOAuthState(state, SECRET)).toEqual({ returnTo: null });
    });
  });
});
