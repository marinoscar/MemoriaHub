/**
 * Test helpers for API tests
 *
 * Provides utilities for:
 * - Creating test users
 * - Generating JWT tokens
 * - Building test requests
 * - Creating mock database rows
 */

import jwt from 'jsonwebtoken';
import type { OAuthProvider } from '@memoriahub/shared';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';
const JWT_ISSUER = 'memoriahub-test';
const JWT_AUDIENCE = 'memoriahub-test';

/**
 * Test user data
 */
export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  oauthProvider: OAuthProvider;
  oauthSubject: string;
  emailVerified?: boolean;
  avatarUrl?: string;
}

/**
 * Create a test user object
 */
export function createTestUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: 'test-user-id-123',
    email: 'test@example.com',
    displayName: 'Test User',
    oauthProvider: 'google',
    oauthSubject: 'google-123456',
    emailVerified: true,
    avatarUrl: 'https://example.com/avatar.jpg',
    ...overrides,
  };
}

/**
 * Create a mock database user row
 */
export function createMockUserRow(user: TestUser) {
  return {
    id: user.id,
    oauth_provider: user.oauthProvider,
    oauth_subject: user.oauthSubject,
    email: user.email,
    email_verified: user.emailVerified ?? true,
    display_name: user.displayName,
    avatar_url: user.avatarUrl ?? null,
    refresh_token_hash: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    last_login_at: null,
  };
}

/**
 * Generate a valid access token for testing
 */
export function generateTestToken(user: TestUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    {
      expiresIn: '1h',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

/**
 * Generate a valid refresh token for testing
 */
export function generateTestRefreshToken(user: TestUser): string {
  return jwt.sign(
    {
      sub: user.id,
      type: 'refresh',
      jti: `test-jti-${Date.now()}`,
    },
    JWT_SECRET,
    {
      expiresIn: '7d',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

/**
 * Generate an expired JWT token for testing
 */
export function generateExpiredToken(user: TestUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    {
      expiresIn: '-1h', // Already expired
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

/**
 * Generate a token with invalid signature
 */
export function generateInvalidSignatureToken(user: TestUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      type: 'access',
    },
    'wrong-secret',
    {
      expiresIn: '1h',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

/**
 * Create Authorization header value
 */
export function authHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Create mock OAuth tokens
 */
export function createMockOAuthTokens() {
  return {
    accessToken: 'mock-google-access-token',
    refreshToken: 'mock-google-refresh-token',
    idToken: 'mock-google-id-token',
    expiresIn: 3600,
    tokenType: 'Bearer',
  };
}

/**
 * Create mock OAuth user info
 */
export function createMockOAuthUserInfo(overrides: Partial<{
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string;
}> = {}) {
  return {
    subject: overrides.subject ?? 'google-subject-123',
    email: overrides.email ?? 'oauth@example.com',
    emailVerified: overrides.emailVerified ?? true,
    displayName: overrides.displayName ?? 'OAuth User',
    avatarUrl: overrides.avatarUrl ?? 'https://example.com/oauth-avatar.jpg',
    rawPayload: {},
  };
}

/**
 * Create mock system settings row
 */
export function createMockSystemSettingsRow(
  category: string,
  settings: Record<string, unknown>
) {
  return {
    id: `settings-${category}`,
    category,
    settings,
    updated_at: new Date(),
    updated_by: 'admin-123',
  };
}

/**
 * Create mock user preferences row
 */
export function createMockUserPreferencesRow(userId: string) {
  return {
    userId,
    preferences: {
      notifications: {
        email: { enabled: true, newSharing: true, comments: true, weeklyDigest: false },
        push: { enabled: true, newSharing: true, comments: true },
      },
      ui: { theme: 'dark' as const, compactMode: false, defaultView: 'grid' as const },
      privacy: { showOnlineStatus: true, allowFaceRecognition: true },
    },
    created_at: new Date(),
    updated_at: new Date(),
  };
}
