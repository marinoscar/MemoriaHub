import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration for MemoriaHub monorepo
 *
 * This configuration enables running tests across all workspaces with:
 * - npm run test          - Run all tests with watch mode
 * - npm run test:unit     - Run all unit tests once
 * - npm run test:ui       - Open Vitest UI for visualization
 * - npm run test:coverage - Run tests with coverage report
 *
 * Workspace projects are defined in vitest.workspace.ts
 */
export default defineConfig({
  test: {
    // Global test configuration
    reporters: process.env.GITHUB_ACTIONS
      ? ['github-actions', 'default']
      : ['default'],
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'dist/',
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/tests/**',
        '**/test/**',
        '**/mocks/**',
        '**/__mocks__/**',
        '**/vitest.config.ts',
        '**/vite.config.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
