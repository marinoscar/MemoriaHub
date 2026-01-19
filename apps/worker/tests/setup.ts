/**
 * Global test setup for Worker tests
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
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/memoriahub_test';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_ACCESS_KEY = 'minioadmin';
process.env.S3_SECRET_KEY = 'minioadmin';
process.env.S3_BUCKET = 'memoriahub-test';
process.env.WORKER_CONCURRENCY = '2';

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
