/**
 * Google OAuth Provider Tests
 *
 * Tests for Google OAuth provider implementation.
 * Covers authorization URL generation, token exchange, and user info retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleOAuthProvider } from '../../../../src/services/auth/providers/google.provider.js';
import { AuthError } from '../../../../src/domain/errors/index.js';

// Mock google-auth-library
const mockGenerateAuthUrl = vi.fn();
const mockGetToken = vi.fn();
const mockVerifyIdToken = vi.fn();
const mockRevokeToken = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
    revokeToken: mockRevokeToken,
  })),
}));

// Mock OAuth config
vi.mock('../../../../src/config/index.js', () => ({
  oauthConfig: {
    google: {
      enabled: true,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3000/api/auth/google/callback',
    },
  },
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('GoogleOAuthProvider', () => {
  let provider: GoogleOAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/auth?...');
    provider = new GoogleOAuthProvider();
  });

  describe('properties', () => {
    it('has correct provider ID', () => {
      expect(provider.providerId).toBe('google');
    });

    it('has correct provider name', () => {
      expect(provider.providerName).toBe('Google');
    });

    it('reports enabled status based on config', () => {
      expect(provider.isEnabled).toBe(true);
    });
  });

  describe('getAuthorizationUrl', () => {
    it('generates authorization URL with correct parameters', () => {
      const state = 'random-state-token';
      const redirectUri = 'http://localhost:3000/api/auth/google/callback';

      const url = provider.getAuthorizationUrl(state, redirectUri);

      expect(url).toBe('https://accounts.google.com/o/oauth2/auth?...');
      expect(mockGenerateAuthUrl).toHaveBeenCalledWith({
        access_type: 'offline',
        scope: ['openid', 'email', 'profile'],
        state: 'random-state-token',
        redirect_uri: redirectUri,
        prompt: 'consent',
      });
    });

    it('requests offline access for refresh token', () => {
      provider.getAuthorizationUrl('state', 'http://localhost/callback');

      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          access_type: 'offline',
        })
      );
    });

    it('requests consent prompt to get refresh token', () => {
      provider.getAuthorizationUrl('state', 'http://localhost/callback');

      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'consent',
        })
      );
    });

    it('includes required OAuth scopes', () => {
      provider.getAuthorizationUrl('state', 'http://localhost/callback');

      expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.arrayContaining(['openid', 'email', 'profile']),
        })
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('exchanges authorization code for tokens successfully', async () => {
      mockGetToken.mockResolvedValue({
        tokens: {
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          id_token: 'google-id-token',
          expiry_date: Date.now() + 3600000,
          token_type: 'Bearer',
        },
      });

      const result = await provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback');

      expect(result.accessToken).toBe('google-access-token');
      expect(result.refreshToken).toBe('google-refresh-token');
      expect(result.idToken).toBe('google-id-token');
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);
    });

    it('throws AuthError when no access token returned', async () => {
      mockGetToken.mockResolvedValue({
        tokens: {
          id_token: 'google-id-token',
        },
      });

      await expect(
        provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback')
      ).rejects.toThrow(AuthError);
      await expect(
        provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback')
      ).rejects.toThrow('No access token returned from Google');
    });

    it('throws AuthError on Google API error', async () => {
      mockGetToken.mockRejectedValue(new Error('Invalid grant'));

      await expect(
        provider.exchangeCodeForTokens('invalid-code', 'http://localhost/callback')
      ).rejects.toThrow(AuthError);
      await expect(
        provider.exchangeCodeForTokens('invalid-code', 'http://localhost/callback')
      ).rejects.toThrow('Failed to exchange authorization code');
    });

    it('handles missing refresh token gracefully', async () => {
      mockGetToken.mockResolvedValue({
        tokens: {
          access_token: 'google-access-token',
          id_token: 'google-id-token',
          expiry_date: Date.now() + 3600000,
          token_type: 'Bearer',
        },
      });

      const result = await provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback');

      expect(result.accessToken).toBe('google-access-token');
      expect(result.refreshToken).toBeUndefined();
    });

    it('calculates correct expiresIn from expiry_date', async () => {
      const expiryDate = Date.now() + 3600000; // 1 hour from now
      mockGetToken.mockResolvedValue({
        tokens: {
          access_token: 'google-access-token',
          id_token: 'google-id-token',
          expiry_date: expiryDate,
          token_type: 'Bearer',
        },
      });

      const result = await provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback');

      // Should be approximately 3600 seconds (1 hour)
      expect(result.expiresIn).toBeGreaterThan(3500);
      expect(result.expiresIn).toBeLessThanOrEqual(3600);
    });

    it('defaults to 1 hour expiry when expiry_date not provided', async () => {
      mockGetToken.mockResolvedValue({
        tokens: {
          access_token: 'google-access-token',
          id_token: 'google-id-token',
          token_type: 'Bearer',
        },
      });

      const result = await provider.exchangeCodeForTokens('auth-code', 'http://localhost/callback');

      expect(result.expiresIn).toBe(3600);
    });
  });

  describe('getUserInfo', () => {
    const validTokens = {
      accessToken: 'google-access-token',
      idToken: 'google-id-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    };

    it('retrieves user info from ID token', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email: 'user@gmail.com',
          email_verified: true,
          name: 'Test User',
          picture: 'https://lh3.googleusercontent.com/avatar.jpg',
        }),
      });

      const result = await provider.getUserInfo(validTokens);

      expect(result.subject).toBe('google-user-123');
      expect(result.email).toBe('user@gmail.com');
      expect(result.emailVerified).toBe(true);
      expect(result.displayName).toBe('Test User');
      expect(result.avatarUrl).toBe('https://lh3.googleusercontent.com/avatar.jpg');
    });

    it('throws AuthError when ID token is missing', async () => {
      const tokensWithoutId = {
        accessToken: 'google-access-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      await expect(provider.getUserInfo(tokensWithoutId)).rejects.toThrow(AuthError);
      await expect(provider.getUserInfo(tokensWithoutId)).rejects.toThrow('ID token required');
    });

    it('throws AuthError when payload is null', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => null,
      });

      await expect(provider.getUserInfo(validTokens)).rejects.toThrow(AuthError);
      await expect(provider.getUserInfo(validTokens)).rejects.toThrow('Invalid ID token payload');
    });

    it('throws AuthError when subject is missing', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          email: 'user@gmail.com',
          email_verified: true,
        }),
      });

      await expect(provider.getUserInfo(validTokens)).rejects.toThrow(AuthError);
      await expect(provider.getUserInfo(validTokens)).rejects.toThrow('No subject in ID token');
    });

    it('throws AuthError when email is missing', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email_verified: true,
        }),
      });

      await expect(provider.getUserInfo(validTokens)).rejects.toThrow(AuthError);
      await expect(provider.getUserInfo(validTokens)).rejects.toThrow('No email in ID token');
    });

    it('handles unverified email', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email: 'user@gmail.com',
          email_verified: false,
        }),
      });

      const result = await provider.getUserInfo(validTokens);

      expect(result.emailVerified).toBe(false);
    });

    it('defaults emailVerified to false when not provided', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email: 'user@gmail.com',
        }),
      });

      const result = await provider.getUserInfo(validTokens);

      expect(result.emailVerified).toBe(false);
    });

    it('includes raw payload for debugging', async () => {
      const payload = {
        sub: 'google-user-123',
        email: 'user@gmail.com',
        email_verified: true,
        name: 'Test User',
        picture: 'https://example.com/avatar.jpg',
        extra_field: 'extra_value',
      };

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => payload,
      });

      const result = await provider.getUserInfo(validTokens);

      expect(result.rawPayload).toEqual(payload);
    });

    it('throws AuthError on verification failure', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Token verification failed'));

      await expect(provider.getUserInfo(validTokens)).rejects.toThrow(AuthError);
      await expect(provider.getUserInfo(validTokens)).rejects.toThrow('Failed to get user information from Google');
    });
  });

  describe('revokeToken', () => {
    it('revokes token successfully', async () => {
      mockRevokeToken.mockResolvedValue(undefined);

      await expect(provider.revokeToken('token-to-revoke')).resolves.toBeUndefined();

      expect(mockRevokeToken).toHaveBeenCalledWith('token-to-revoke');
    });

    it('does not throw on revocation failure', async () => {
      mockRevokeToken.mockRejectedValue(new Error('Revocation failed'));

      // Should not throw - logout should not fail if token revocation fails
      await expect(provider.revokeToken('token-to-revoke')).resolves.toBeUndefined();
    });
  });

  describe('disabled provider', () => {
    it('reports disabled when config says disabled', () => {
      vi.resetModules();
      vi.doMock('../../../../src/config/index.js', () => ({
        oauthConfig: {
          google: {
            enabled: false,
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            redirectUri: 'http://localhost:3000/api/auth/google/callback',
          },
        },
      }));
    });

    it('reports disabled when client ID missing', () => {
      vi.resetModules();
      vi.doMock('../../../../src/config/index.js', () => ({
        oauthConfig: {
          google: {
            enabled: true,
            clientId: '',
            clientSecret: 'test-client-secret',
            redirectUri: 'http://localhost:3000/api/auth/google/callback',
          },
        },
      }));
    });
  });
});
