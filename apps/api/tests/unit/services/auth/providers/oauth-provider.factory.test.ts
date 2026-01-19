/**
 * OAuth Provider Factory Tests
 *
 * Tests for OAuth provider factory implementation.
 * Covers provider retrieval, available providers listing, and provider availability checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '../../../../../src/domain/errors/index.js';

// Use vi.hoisted to create mocks that can be referenced in vi.mock
const { mockGoogleProvider } = vi.hoisted(() => {
  const mockGoogleProvider = {
    providerId: 'google',
    providerName: 'Google',
    isEnabled: true,
    getAuthorizationUrl: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
    getUserInfo: vi.fn(),
    revokeToken: vi.fn(),
  };

  return { mockGoogleProvider };
});

// Mock the google provider module
vi.mock('../../../../../src/services/auth/providers/google.provider.js', () => ({
  googleOAuthProvider: mockGoogleProvider,
}));

// Import after mocks
import {
  getOAuthProvider,
  getAvailableProviders,
  isProviderAvailable,
} from '../../../../../src/services/auth/providers/oauth-provider.factory.js';

describe('OAuth Provider Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset provider to enabled state
    mockGoogleProvider.isEnabled = true;
  });

  describe('getOAuthProvider', () => {
    it('returns google provider when enabled', () => {
      const provider = getOAuthProvider('google');

      expect(provider).toBeDefined();
      expect(provider.providerId).toBe('google');
      expect(provider.providerName).toBe('Google');
    });

    it('throws NotFoundError for unknown provider', () => {
      expect(() => getOAuthProvider('facebook' as 'google')).toThrow(NotFoundError);
      expect(() => getOAuthProvider('facebook' as 'google')).toThrow(
        "OAuth provider 'facebook' not found"
      );
    });

    it('throws NotFoundError when provider is not enabled', () => {
      mockGoogleProvider.isEnabled = false;

      expect(() => getOAuthProvider('google')).toThrow(NotFoundError);
      expect(() => getOAuthProvider('google')).toThrow(
        "OAuth provider 'google' is not configured"
      );
    });

    it('returns provider with all required methods', () => {
      const provider = getOAuthProvider('google');

      expect(typeof provider.getAuthorizationUrl).toBe('function');
      expect(typeof provider.exchangeCodeForTokens).toBe('function');
      expect(typeof provider.getUserInfo).toBe('function');
      expect(typeof provider.revokeToken).toBe('function');
    });
  });

  describe('getAvailableProviders', () => {
    it('returns list of enabled providers', () => {
      const providers = getAvailableProviders();

      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({
        id: 'google',
        name: 'Google',
        authUrl: '/api/auth/google',
      });
    });

    it('returns empty list when no providers are enabled', () => {
      mockGoogleProvider.isEnabled = false;

      const providers = getAvailableProviders();

      expect(providers).toHaveLength(0);
    });

    it('includes correct authUrl format', () => {
      const providers = getAvailableProviders();

      expect(providers[0].authUrl).toBe('/api/auth/google');
    });

    it('returns provider info with id, name, and authUrl', () => {
      const providers = getAvailableProviders();

      providers.forEach((provider) => {
        expect(provider).toHaveProperty('id');
        expect(provider).toHaveProperty('name');
        expect(provider).toHaveProperty('authUrl');
        expect(typeof provider.id).toBe('string');
        expect(typeof provider.name).toBe('string');
        expect(typeof provider.authUrl).toBe('string');
      });
    });
  });

  describe('isProviderAvailable', () => {
    it('returns true for enabled provider', () => {
      const isAvailable = isProviderAvailable('google');

      expect(isAvailable).toBe(true);
    });

    it('returns false for disabled provider', () => {
      mockGoogleProvider.isEnabled = false;

      const isAvailable = isProviderAvailable('google');

      expect(isAvailable).toBe(false);
    });

    it('returns false for unknown provider', () => {
      const isAvailable = isProviderAvailable('facebook' as 'google');

      expect(isAvailable).toBe(false);
    });

    it('returns false for microsoft (not implemented yet)', () => {
      const isAvailable = isProviderAvailable('microsoft');

      expect(isAvailable).toBe(false);
    });

    it('returns false for github (not implemented yet)', () => {
      const isAvailable = isProviderAvailable('github');

      expect(isAvailable).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles provider state changes', () => {
      // Initially enabled
      expect(isProviderAvailable('google')).toBe(true);

      // Disable
      mockGoogleProvider.isEnabled = false;
      expect(isProviderAvailable('google')).toBe(false);

      // Re-enable
      mockGoogleProvider.isEnabled = true;
      expect(isProviderAvailable('google')).toBe(true);
    });

    it('getAvailableProviders reflects current state', () => {
      // With provider enabled
      let providers = getAvailableProviders();
      expect(providers.some((p) => p.id === 'google')).toBe(true);

      // Disable provider
      mockGoogleProvider.isEnabled = false;
      providers = getAvailableProviders();
      expect(providers.some((p) => p.id === 'google')).toBe(false);
    });
  });
});
