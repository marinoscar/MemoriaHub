/**
 * Global test setup for API tests
 *
 * This file runs before all tests and sets up:
 * - Environment variables for testing
 * - Mock configurations
 * - Global utilities
 */

import { beforeAll, afterAll, afterEach, vi } from 'vitest';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent'; // Suppress logs during tests

// Mock environment variables for tests
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';
process.env.JWT_EXPIRES_IN = '15m';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/memoriahub_test';

beforeAll(() => {
  // Global setup before all tests
});

afterAll(() => {
  // Global cleanup after all tests
});

afterEach(() => {
  // Reset all mocks after each test
  vi.clearAllMocks();
});
