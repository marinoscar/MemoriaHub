/**
 * Example unit test file
 *
 * This file demonstrates the testing patterns for the API service.
 * Replace with actual tests as you implement features.
 */

import { describe, it, expect } from 'vitest';
import { createTestUser, generateTestToken } from '../helpers/index.js';

describe('Test Helpers', () => {
  describe('createTestUser', () => {
    it('creates a test user with default values', () => {
      const user = createTestUser();

      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.displayName).toBe('Test User');
      expect(user.oauthProvider).toBe('google');
    });

    it('allows overriding default values', () => {
      const user = createTestUser({
        email: 'custom@example.com',
        displayName: 'Custom User',
      });

      expect(user.email).toBe('custom@example.com');
      expect(user.displayName).toBe('Custom User');
    });
  });

  describe('generateTestToken', () => {
    it('generates a valid JWT token', () => {
      const user = createTestUser();
      const token = generateTestToken(user);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });
  });
});

describe('Example API Tests', () => {
  it('should pass a basic test', () => {
    expect(1 + 1).toBe(2);
  });

  it('should handle async operations', async () => {
    const result = await Promise.resolve('success');
    expect(result).toBe('success');
  });

  it('should work with objects', () => {
    const obj = { name: 'test', value: 42 };
    expect(obj).toMatchObject({ name: 'test' });
    expect(obj.value).toBeGreaterThan(0);
  });
});
