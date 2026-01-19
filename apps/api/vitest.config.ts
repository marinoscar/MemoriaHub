import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest configuration for the API service
 *
 * Tests are organized in:
 * - tests/unit/     - Fast unit tests (no external deps)
 * - tests/integration/ - Tests with database/external services
 */
export default defineConfig({
  test: {
    name: 'api',
    root: resolve(__dirname),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000, // 30s for integration tests
    hookTimeout: 30000,
    // Use threads for faster execution
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    // Coverage for this workspace
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts', // Entry point
        'src/types/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
