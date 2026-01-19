/**
 * Test helpers for API tests
 *
 * Provides utilities for:
 * - Creating test users
 * - Generating JWT tokens
 * - Building test requests
 */

import jwt from 'jsonwebtoken';

/**
 * Test user data
 */
export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  oauthProvider: 'google' | 'microsoft' | 'github';
  oauthSubject: string;
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
    ...overrides,
  };
}

/**
 * Generate a JWT token for testing
 */
export function generateTestToken(user: TestUser): string {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.displayName,
    },
    secret,
    { expiresIn: '1h' }
  );
}

/**
 * Generate an expired JWT token for testing
 */
export function generateExpiredToken(user: TestUser): string {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.displayName,
    },
    secret,
    { expiresIn: '-1h' } // Already expired
  );
}

/**
 * Create Authorization header value
 */
export function authHeader(token: string): string {
  return `Bearer ${token}`;
}
